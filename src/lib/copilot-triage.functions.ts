import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  callModel,
  callSegmentation,
  configuredModelId,
  configuredSamModelId,
  missingTriageConfig,
  ModelCallError,
} from "./copilot-model.server";
import { assembleSegmentation, segmentConcepts, type ConceptSegmentation } from "./copilot-segmentation";
import {
  buildTriageInput,
  clearerPhotoRequest,
  conceptsFromNote,
  draftHasCost,
  interpretationSchema,
  parseJsonObject,
  screenFindings,
  TRIAGE_FAILED_MESSAGE,
  TRIAGE_SYSTEM_PROMPT,
  type FindingsRecord,
  type SegmentationRecord,
} from "./copilot-triage";
import { TONE_VALUES } from "./copilot-shared";

export const PHOTO_BUCKET = "maintenance-photos";
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_NOTE_CHARS = 500;
/** Signed links are short-lived: long enough for one triage run or one page view. */
const SIGNED_URL_SECONDS = 600;
const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type TriageRow = Database["public"]["Tables"]["copilot_photo_triage"]["Row"];

export type RunTriageResult = { ok: true; triageId: string } | { ok: false; error: string };

/* ---------- Run: upload → SAM → interpretation → drafts ---------- */

export const runPhotoTriage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => {
    if (!(input instanceof FormData)) throw new Error("Expected form data");
    const photo = input.get("photo");
    if (!(photo instanceof File)) throw new Error("A photo is required");
    const note = String(input.get("note") ?? "").trim();
    return {
      tenant_id: z.string().uuid().parse(input.get("tenant_id")),
      note: z.string().max(MAX_NOTE_CHARS).parse(note) || null,
      tone: z.enum(TONE_VALUES).parse(input.get("tone") ?? "friendly"),
      photo,
    };
  })
  .handler(async ({ data, context }): Promise<RunTriageResult> => {
    const { supabase } = context;

    if (!PHOTO_TYPES[data.photo.type]) {
      return { ok: false, error: "Please upload a JPG, PNG, or WebP photo." };
    }
    if (data.photo.size === 0 || data.photo.size > MAX_PHOTO_BYTES) {
      return { ok: false, error: "The photo must be smaller than 10 MB." };
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("demo_tenants")
      .select("id, full_name, property_label")
      .eq("id", data.tenant_id)
      .maybeSingle();
    if (tenantError) throw new Error("Could not load tenant");
    if (!tenant) return { ok: false, error: "Tenant not found." };

    const concepts = conceptsFromNote(data.note);

    // Every failed run: the row leaves "processing" for "failed" and a model_error row is
    // written. Both writes are checked; the run reports failure either way.
    async function failRun(
      code: string,
      modelId: string | null,
      triageId: string | null,
      opts: { message?: string; detail?: Record<string, unknown> } = {},
    ) {
      if (triageId) {
        const { error } = await supabase.from("copilot_photo_triage").update({ status: "failed" }).eq("id", triageId);
        if (error) console.error("[triage] marking run failed did not save", error);
      }
      const { error: auditError } = await supabase.from("copilot_audit_log").insert({
        tenant_id: tenant!.id,
        action: "model_error",
        model_id: modelId,
        detail: { stage: "photo_triage", error_code: code, triage_id: triageId, concepts, ...opts.detail } as Json,
      });
      if (auditError) console.error("[triage] model_error audit insert failed", auditError);
      return { ok: false as const, error: opts.message ?? TRIAGE_FAILED_MESSAGE };
    }

    // Fail honestly before storing anything when a model setting is missing.
    const missing = missingTriageConfig();
    if (missing.length) {
      console.error("[triage] not configured; missing:", missing.join(", "));
      return failRun("not_configured", configuredSamModelId(), null);
    }

    // 1. Store the photo in the private bucket.
    const path = `${tenant.id}/${crypto.randomUUID()}.${PHOTO_TYPES[data.photo.type]}`;
    const upload = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, data.photo, { contentType: data.photo.type, upsert: false });
    if (upload.error) {
      console.error("[triage] upload failed", upload.error);
      return { ok: false, error: "The photo couldn't be saved. Please try again." };
    }

    const { data: triage, error: triageError } = await supabase
      .from("copilot_photo_triage")
      .insert({
        tenant_id: tenant.id,
        photo_path: path,
        concept_prompt: concepts.join("; "),
        status: "processing",
      })
      .select("id")
      .single();
    if (triageError || !triage) {
      console.error("[triage] row insert failed", triageError);
      return { ok: false, error: "The photo couldn't be saved. Please try again." };
    }

    const signed = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) {
      console.error("[triage] signed link failed", signed.error);
      return failRun("signed_url_failed", null, triage.id);
    }
    const photoUrl = signed.data.signedUrl;

    // 2. Localize with SAM: one request per concept phrase, keep every region.
    // An empty output lane means zero matches for that concept, so it counts as
    // zero regions; HTTP errors, missing settings and malformed replies still fail.
    let samResults: ConceptSegmentation[];
    try {
      samResults = await segmentConcepts(
        concepts,
        (concept) => callSegmentation(concept, photoUrl),
        (error) =>
          error instanceof ModelCallError && error.code === "empty_output" ? error.modelId : undefined,
      );
    } catch (error) {
      const code = error instanceof ModelCallError ? error.code : "unknown";
      const modelId = error instanceof ModelCallError ? error.modelId : configuredSamModelId();
      return failRun(`segmentation_${code}`, modelId, triage.id);
    }

    const {
      regions,
      record: segmentation,
      regionsPerConcept,
    } = assembleSegmentation(samResults, configuredSamModelId());
    const samModelId = segmentation.sam_model_id;
    const { error: segmentationSaveError } = await supabase
      .from("copilot_photo_triage")
      .update({ segmentation: segmentation as unknown as Json })
      .eq("id", triage.id);
    if (segmentationSaveError) {
      console.error("[triage] segmentation save failed", segmentationSaveError);
      return failRun("segmentation_save_failed", samModelId || null, triage.id);
    }

    // 3. Interpretation pass: photo + SAM regions + note, forced into five fields.
    let interpretation: ReturnType<typeof interpretationSchema.parse>;
    let interpretationModelId: string;
    try {
      const reply = await callModel(
        TRIAGE_SYSTEM_PROMPT,
        buildTriageInput({
          tenantName: tenant.full_name,
          propertyLabel: tenant.property_label,
          note: data.note,
          regions,
          concepts,
          tone: data.tone,
        }),
        { images: [photoUrl], temperature: 0, timeoutMs: 60_000 },
      );
      const parsed = interpretationSchema.safeParse(parseJsonObject(reply.text));
      if (!parsed.success) {
        throw new ModelCallError("Interpretation did not match the five fields", reply.modelId, "invalid_output");
      }
      interpretation = parsed.data;
      interpretationModelId = reply.modelId;
    } catch (error) {
      const code = error instanceof ModelCallError ? error.code : "unknown";
      const modelId = error instanceof ModelCallError ? error.modelId : configuredModelId();
      return failRun(`interpretation_${code}`, modelId, triage.id);
    }

    // 4. Hard rules in code: drop rule-breaking findings; no findings → clearer-photo request only.
    const screened = screenFindings(
      interpretation.visible_findings,
      new Set(regions.map((r) => r.n)),
    );
    const usable = screened.kept.length > 0;
    const tenantReply = usable ? interpretation.drafts.tenant_reply : clearerPhotoRequest(tenant.full_name);
    const workOrder = usable ? interpretation.drafts.work_order_summary : "";

    if (usable && (!tenantReply || !workOrder || draftHasCost(tenantReply) || draftHasCost(workOrder))) {
      // A missing draft or a cost estimate would be a fake result: fail instead.
      return failRun("interpretation_rule_violation", interpretationModelId, triage.id);
    }

    // 5. The tenant reply is a normal pending draft, so it gets the same risk check and approval.
    const { data: draft, error: draftError } = await supabase
      .from("copilot_drafts")
      .insert({
        tenant_id: tenant.id,
        message_type: "maintenance_update",
        tone: data.tone,
        draft_body: tenantReply,
        status: "pending",
        risk_flags: null,
      })
      .select("id")
      .single();
    if (draftError || !draft) {
      console.error("[triage] draft insert failed", draftError);
      return failRun("draft_save_failed", interpretationModelId, triage.id, {
        message: "The draft couldn't be saved. Please try again.",
      });
    }

    const findings: FindingsRecord = {
      version: 1,
      note: data.note,
      photo_usable: usable,
      interpretation_model_id: interpretationModelId,
      visible_findings: screened.kept,
      not_determinable: interpretation.not_determinable,
      context_questions: interpretation.context_questions,
      urgency_routing: usable
        ? interpretation.urgency_routing
        : {
            urgency: null,
            vendor: "Not determinable yet",
            why: "The photo can't support visible findings, so routing waits for a clearer photo.",
          },
      tenant_reply_draft_id: draft.id,
      work_order: usable ? { body: workOrder, status: "pending", approved_at: null } : null,
      dropped_findings: screened.dropped,
    };

    const { error: saveError } = await supabase
      .from("copilot_photo_triage")
      .update({
        findings: findings as unknown as Json,
        status: usable ? "completed" : "needs_clearer_photo",
      })
      .eq("id", triage.id);
    if (saveError) {
      console.error("[triage] findings save failed", saveError);
      return failRun("findings_save_failed", interpretationModelId, triage.id, {
        message: "The triage result couldn't be saved. Please try again.",
        detail: { draft_id: draft.id },
      });
    }

    const { error: auditError } = await supabase.from("copilot_audit_log").insert({
      draft_id: draft.id,
      tenant_id: tenant.id,
      action: "photo_triage",
      model_id: interpretationModelId,
      detail: {
        triage_id: triage.id,
        sam_model_id: samModelId,
        concepts,
        tone: data.tone,
        regions: regions.length,
        regions_per_concept: regionsPerConcept,
        visible_findings: screened.kept.length,
        dropped_findings: screened.dropped,
        outcome: usable ? "findings" : "needs_clearer_photo",
      },
    });
    if (auditError) {
      // A run with no photo_triage record must not be reported as complete.
      console.error("[triage] photo_triage audit insert failed", auditError);
      return failRun("audit_failed", interpretationModelId, triage.id, { detail: { draft_id: draft.id } });
    }

    return { ok: true, triageId: triage.id };
  });

/* ---------- Reads ---------- */

export const listTriages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("copilot_photo_triage")
      .select("id, created_at, status, concept_prompt, tenant:demo_tenants(full_name)")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error("Could not load photo triage runs");
    return data.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      status: r.status,
      concept_prompt: r.concept_prompt,
      tenant_name: r.tenant?.full_name ?? null,
    }));
  });

export const getTriage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ triageId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from("copilot_photo_triage")
      .select("*, tenant:demo_tenants(id, full_name, property_label)")
      .eq("id", data.triageId)
      .maybeSingle();
    if (error) throw new Error("Could not load photo triage");
    if (!row) return null;

    // The photo is only ever shown through a short-lived signed link.
    const signed = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(row.photo_path, SIGNED_URL_SECONDS);

    const findings = row.findings as unknown as FindingsRecord | null;
    let draft: { id: string; status: string; risk_checked_at: string | null } | null = null;
    if (findings?.tenant_reply_draft_id) {
      const { data: d } = await supabase
        .from("copilot_drafts")
        .select("id, status, risk_checked_at")
        .eq("id", findings.tenant_reply_draft_id)
        .maybeSingle();
      draft = d ?? null;
    }

    return {
      id: row.id,
      created_at: row.created_at,
      status: row.status,
      concept_prompt: row.concept_prompt,
      tenant: row.tenant,
      photoUrl: signed.data?.signedUrl ?? null,
      segmentation: row.segmentation as unknown as SegmentationRecord | null,
      findings,
      draft,
    };
  });

/* ---------- Work order: its own approve-and-copy ---------- */

export const WORK_ORDER_COST_MESSAGE =
  "A work order cannot include a cost estimate. Remove any prices or dollar amounts and approve again.";


export const approveWorkOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({ triage_id: z.string().uuid(), body: z.string().trim().min(1).max(5000) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from("copilot_photo_triage")
      .select("id, tenant_id, findings")
      .eq("id", data.triage_id)
      .maybeSingle();
    if (error) throw new Error("Could not load photo triage");
    if (!row) throw new Error("Photo triage not found");
    const findings = row.findings as unknown as FindingsRecord | null;
    if (!findings?.work_order) throw new Error("This triage has no work order");
    if (findings.work_order.status !== "pending") throw new Error("This work order has already been approved");
    // Same cost screen the generation path applies: an edit can't slip a cost in.
    if (draftHasCost(data.body)) throw new Error(WORK_ORDER_COST_MESSAGE);

    const edited = data.body !== findings.work_order.body;
    const next: FindingsRecord = {
      ...findings,
      work_order: { body: data.body, status: "approved", approved_at: new Date().toISOString() },
    };
    const { data: updated, error: updateError } = await supabase
      .from("copilot_photo_triage")
      .update({ findings: next as unknown as Json })
      .eq("id", row.id)
      .eq("findings->work_order->>status", "pending")
      .select("id")
      .maybeSingle();
    if (updateError) throw new Error("Could not approve the work order");
    if (!updated) throw new Error("This work order has already been approved");

    const { error: auditError } = await supabase.from("copilot_audit_log").insert({
      tenant_id: row.tenant_id,
      action: "approve",
      model_id: null,
      detail: { kind: "work_order", triage_id: row.id, edited },
    });
    if (auditError) {
      // No approval without its record: put the work order back to pending.
      console.error("[triage] work order approve audit insert failed", auditError);
      const { error: revertError } = await supabase
        .from("copilot_photo_triage")
        .update({ findings: findings as unknown as Json })
        .eq("id", row.id)
        .eq("findings->work_order->>status", "approved");
      if (revertError) {
        console.error("[triage] reverting work order approval failed", revertError);
        throw new Error(
          "The work order was marked approved, but its audit record couldn't be written. Check the audit log before relying on it.",
        );
      }
      throw new Error("Could not approve the work order");
    }

    return next.work_order!;
  });
