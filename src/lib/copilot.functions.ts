import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { buildDraftInput, COPILOT_SYSTEM_RULES } from "./copilot-draft.server";
import { callModel, configuredModelId, ModelCallError } from "./copilot-model.server";
import {
  buildRiskReviewInput,
  parseJsonArray,
  RISK_REVIEW_SYSTEM_PROMPT,
  runDeterministicChecks,
  verifySemanticFlags,
  type LayerRun,
  type RiskInfo,
  type RiskResult,
} from "./copilot-risk";
import {
  buildFacts,
  MESSAGE_TYPE_VALUES,
  TONE_VALUES,
  type Fact,
  type TenantRecord,
} from "./copilot-shared";

const TENANT_COLUMNS =
  "id, full_name, property_label, lease_start, lease_end, rent_cents, due_day, balance_cents, lease_late_fee_cents, deposit_status, termination_date, possession_date";

const DEMO_EMAIL = "demo-landlord@example.com";

export type DraftRow = Database["public"]["Tables"]["copilot_drafts"]["Row"];

/* ---------- One-click demo sign-in (public by design) ---------- */

export const startDemoSession = createServerFn({ method: "POST" }).handler(async () => {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("Demo sign-in is not configured");

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Ensure the shared demo account exists. The demo flag lives in app_metadata,
  // which only the server can set; database policies require it.
  const created = await supabaseAdmin.auth.admin.createUser({
    email: DEMO_EMAIL,
    email_confirm: true,
    app_metadata: { demo: true },
  });
  if (created.error && created.error.code !== "email_exists") {
    console.error("[demo] createUser failed", created.error);
    throw new Error("Could not start the demo session");
  }

  const link = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email: DEMO_EMAIL });
  if (link.error || !link.data.properties?.hashed_token) {
    console.error("[demo] generateLink failed", link.error);
    throw new Error("Could not start the demo session");
  }
  if (link.data.user.app_metadata?.["demo"] !== true) {
    await supabaseAdmin.auth.admin.updateUserById(link.data.user.id, {
      app_metadata: { demo: true },
    });
  }

  // Exchange the one-time token on a throwaway client so the admin client never holds a session.
  const exchange = createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) {
          h.delete("Authorization");
        }
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
  const verified = await exchange.auth.verifyOtp({
    token_hash: link.data.properties.hashed_token,
    type: "magiclink",
  });
  if (verified.error || !verified.data.session) {
    console.error("[demo] verifyOtp failed", verified.error);
    throw new Error("Could not start the demo session");
  }
  return {
    access_token: verified.data.session.access_token,
    refresh_token: verified.data.session.refresh_token,
  };
});

/* ---------- Reads ---------- */

export const listTenants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("demo_tenants")
      .select(TENANT_COLUMNS)
      .order("full_name");
    if (error) throw new Error("Could not load tenants");
    return data satisfies TenantRecord[];
  });

export const getTenant = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ tenantId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: tenant, error } = await context.supabase
      .from("demo_tenants")
      .select(TENANT_COLUMNS)
      .eq("id", data.tenantId)
      .maybeSingle();
    if (error) throw new Error("Could not load tenant");
    return tenant satisfies TenantRecord | null;
  });

export const listAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("copilot_audit_log")
      .select("id, created_at, action, model_id, draft_id, detail, tenant:demo_tenants(full_name)")
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error("Could not load audit log");
    return data.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      action: row.action,
      model_id: row.model_id,
      draft_id: row.draft_id,
      detail: auditSummary(row.action, row.detail),
      tenant_name: row.tenant?.full_name ?? null,
    }));
  });

export const getDraft = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ draftId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: draft, error } = await context.supabase
      .from("copilot_drafts")
      .select("*")
      .eq("id", data.draftId)
      .maybeSingle();
    if (error) throw new Error("Could not load draft");
    return draft satisfies DraftRow | null;
  });

/* ---------- copilot_draft ---------- */

export type CopilotDraftResult =
  | { ok: true; draft: DraftRow; facts: Fact[]; modelId: string }
  | { ok: false; error: string };

export const copilotDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        message_type: z.enum(MESSAGE_TYPE_VALUES),
        tone: z.enum(TONE_VALUES),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<CopilotDraftResult> => {
    const { supabase } = context;

    // Load ONLY this tenant's row.
    const { data: tenant, error: tenantError } = await supabase
      .from("demo_tenants")
      .select(TENANT_COLUMNS)
      .eq("id", data.tenant_id)
      .maybeSingle();
    if (tenantError) throw new Error("Could not load tenant");
    if (!tenant) return { ok: false, error: "Tenant not found." };

    const facts = buildFacts(tenant, data.message_type);
    const input = buildDraftInput({ facts, messageType: data.message_type, tone: data.tone });

    let result: { text: string; modelId: string };
    try {
      result = await callModel(COPILOT_SYSTEM_RULES, input);
    } catch (error) {
      const modelId = error instanceof ModelCallError ? error.modelId : configuredModelId();
      const code = error instanceof ModelCallError ? error.code : "unknown";
      await supabase.from("copilot_audit_log").insert({
        tenant_id: tenant.id,
        action: "model_error",
        model_id: modelId,
        detail: { message_type: data.message_type, tone: data.tone, error_code: code },
      });
      return { ok: false, error: "The AI couldn't write a draft just now. Please try again." };
    }

    const { data: draft, error: draftError } = await supabase
      .from("copilot_drafts")
      .insert({
        tenant_id: tenant.id,
        message_type: data.message_type,
        tone: data.tone,
        draft_body: result.text,
        status: "pending",
        risk_flags: null,
      })
      .select("*")
      .single();
    if (draftError || !draft) {
      console.error("[copilot] draft insert failed", draftError);
      return { ok: false, error: "The draft couldn't be saved. Please try again." };
    }

    await supabase.from("copilot_audit_log").insert({
      draft_id: draft.id,
      tenant_id: tenant.id,
      action: "generate",
      model_id: result.modelId,
      detail: {
        message_type: data.message_type,
        tone: data.tone,
        fact_fields: facts.map((f) => f.field),
      },
    });

    return { ok: true, draft, facts, modelId: result.modelId };
  });

/* ---------- Approve / discard ---------- */

export const PARTIAL_ACK_REQUIRED_MESSAGE =
  "The language review did not run. Confirm you reviewed this draft yourself before approving.";

export const decideDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        draft_id: z.string().uuid(),
        decision: z.enum(["approve", "discard"]),
        draft_body: z.string().trim().min(1).max(5000).optional(),
        // Required to approve a draft whose stored risk result is partial.
        partial_review_acknowledged: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: current, error: readError } = await supabase
      .from("copilot_drafts")
      .select("id, tenant_id, status, draft_body, risk_flags")
      .eq("id", data.draft_id)
      .maybeSingle();
    if (readError) throw new Error("Could not load draft");
    if (!current) throw new Error("Draft not found");
    if (current.status !== "pending") throw new Error("This draft has already been decided");

    const approvingPartial = data.decision === "approve" && isPartialRiskResult(current.risk_flags);
    if (approvingPartial && data.partial_review_acknowledged !== true) {
      throw new Error(PARTIAL_ACK_REQUIRED_MESSAGE);
    }

    const edited =
      data.decision === "approve" &&
      data.draft_body !== undefined &&
      data.draft_body !== current.draft_body;

    const { data: updated, error: updateError } = await supabase
      .from("copilot_drafts")
      .update({
        status: data.decision === "approve" ? "approved" : "discarded",
        decided_at: new Date().toISOString(),
        decided_by: userId,
        ...(edited && data.draft_body ? { draft_body: data.draft_body } : {}),
      })
      .eq("id", data.draft_id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();
    if (updateError) throw new Error("Could not update draft");
    if (!updated) throw new Error("This draft has already been decided");

    await supabase.from("copilot_audit_log").insert(
      approvingPartial
        ? {
            draft_id: updated.id,
            tenant_id: updated.tenant_id,
            action: "approved_after_partial_review",
            model_id: null,
            detail: {
              edited,
              partial_review_acknowledged: true,
              summary: "Approved after the landlord confirmed a manual review — language review did not run",
            },
          }
        : {
            draft_id: updated.id,
            tenant_id: updated.tenant_id,
            action: data.decision,
            model_id: null,
            detail: { edited },
          },
    );

    return updated;
  });

/* ---------- Risk check (slice 2): runs only when the landlord asks ---------- */

export const RISK_CHECK_FAILED_MESSAGE = "Risk check couldn't run — review carefully";

/** Per-call options for the language review only; every other call keeps the adapter default. */
export const RISK_REVIEW_CALL_OPTIONS = { temperature: 0, timeoutMs: 60_000 } as const;

/** "complete" = rule checks and language review both ran; "partial" = rule checks only. */
export type RiskCheckStatus = "complete" | "partial";
export type StoredLayerRun = Omit<LayerRun, "status"> & { status: LayerRun["status"] | "not_run" };
/** What is stored in copilot_drafts.risk_flags. Results saved before `status` existed were complete. */
export type StoredRiskResult = Omit<RiskResult, "layers"> & {
  status: RiskCheckStatus;
  layers: StoredLayerRun[];
};

export const LANGUAGE_REVIEW_NOT_RUN_INFO = {
  check: "semantic",
  title: "Language review could not run",
  detail:
    "The AI language review didn't finish, so only the rule checks ran. Read the draft yourself for threatening, discriminatory, retaliatory or otherwise risky wording before approving.",
} as const satisfies RiskInfo;

export function isPartialRiskResult(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { status?: unknown }).status === "partial"
  );
}

/** A risk result built from the rule checks alone, used when the language review fails. */
export function buildPartialRiskResult(args: {
  body: string;
  checkedAt: string;
  modelId: string;
  deterministic: ReturnType<typeof runDeterministicChecks>;
}): StoredRiskResult {
  return {
    version: 1,
    status: "partial",
    checked_body: args.body,
    checked_at: args.checkedAt,
    model_id: args.modelId,
    layers: [
      ...args.deterministic.layers,
      { check: "semantic", layer: "semantic", status: "not_run" },
    ],
    deterministic_flags: args.deterministic.flags,
    semantic_flags: [],
    not_determinable: args.deterministic.notDeterminable,
    info: [...args.deterministic.info, { ...LANGUAGE_REVIEW_NOT_RUN_INFO }],
    rejected_quote_count: 0,
    malformed_flag_count: 0,
  };
}

export type RiskCheckResult =
  | { ok: true; result: StoredRiskResult; riskCheckedAt: string }
  | { ok: false; error: string };

/** Today's date (YYYY-MM-DD) in North Carolina's time zone. */
function todayInNorthCarolina(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export const runRiskCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        draft_id: z.string().uuid(),
        // The text currently in the editor; the check runs on exactly this text.
        draft_body: z.string().trim().min(1).max(5000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<RiskCheckResult> => {
    const { supabase } = context;

    const { data: draft, error: draftError } = await supabase
      .from("copilot_drafts")
      .select("id, tenant_id, status, message_type")
      .eq("id", data.draft_id)
      .maybeSingle();
    if (draftError) throw new Error("Could not load draft");
    if (!draft) return { ok: false, error: "Draft not found." };
    if (draft.status !== "pending") {
      return { ok: false, error: "Only pending drafts can be risk-checked." };
    }

    const [{ data: tenant, error: tenantError }, { data: others, error: othersError }] =
      await Promise.all([
        supabase.from("demo_tenants").select(TENANT_COLUMNS).eq("id", draft.tenant_id).maybeSingle(),
        supabase.from("demo_tenants").select("id, full_name, property_label").neq("id", draft.tenant_id),
      ]);
    if (tenantError || othersError) throw new Error("Could not load tenant");
    if (!tenant) return { ok: false, error: "Tenant not found." };

    const messageType = z.enum(MESSAGE_TYPE_VALUES).parse(draft.message_type);
    const body = data.draft_body;

    // Step 1: deterministic validators (code, not the model).
    const deterministic = runDeterministicChecks({
      body,
      tenant,
      others: others ?? [],
      messageType,
      today: todayInNorthCarolina(),
    });

    // Step 2: semantic pass — only the draft text and the category list go to the model.
    // Step 3: span verification — every quote must occur exactly once in the draft.
    let semantic: ReturnType<typeof verifySemanticFlags> | null = null;
    let modelId: string | null;
    let failureCode: string | null = null;
    try {
      // Deterministic sampling, no reply-length cap (reasoning-style models can spend a
      // cap before writing any output), and a longer timeout for this one call only.
      const reply = await callModel(
        RISK_REVIEW_SYSTEM_PROMPT,
        buildRiskReviewInput(body),
        { ...RISK_REVIEW_CALL_OPTIONS },
      );
      const items = parseJsonArray(reply.text);
      if (!items) throw new ModelCallError("Model reply was not a JSON array", reply.modelId, "invalid_output");
      semantic = verifySemanticFlags(items, body);
      modelId = reply.modelId;
    } catch (error) {
      modelId = error instanceof ModelCallError ? error.modelId : configuredModelId();
      failureCode = error instanceof ModelCallError ? error.code : "unknown";
      await supabase.from("copilot_audit_log").insert({
        draft_id: draft.id,
        tenant_id: draft.tenant_id,
        action: "model_error",
        model_id: modelId,
        detail: { stage: "risk_check", error_code: failureCode },
      });
    }

    // Step 4: store everything on the draft and audit the counts. When the language
    // review failed, the rule-check results are kept as an explicitly partial result.
    const checkedAt = new Date().toISOString();
    const result: StoredRiskResult = semantic
      ? {
          version: 1,
          status: "complete",
          checked_body: body,
          checked_at: checkedAt,
          model_id: modelId ?? "",
          layers: [
            ...deterministic.layers,
            { check: "semantic", layer: "semantic", status: "ran" },
          ],
          deterministic_flags: deterministic.flags,
          semantic_flags: semantic.flags,
          not_determinable: deterministic.notDeterminable,
          info: deterministic.info,
          rejected_quote_count: semantic.rejected,
          malformed_flag_count: semantic.malformed,
        }
      : buildPartialRiskResult({ body, checkedAt, modelId: modelId ?? "not_configured", deterministic });

    const { data: updated, error: updateError } = await supabase
      .from("copilot_drafts")
      .update({ risk_flags: result as unknown as Json, risk_checked_at: checkedAt })
      .eq("id", draft.id)
      .eq("status", "pending")
      .select("risk_checked_at")
      .maybeSingle();
    if (updateError) {
      console.error("[copilot] risk result save failed", updateError);
      if (result.status === "partial") {
        // Nothing usable was saved: never leave an older result looking current.
        await supabase
          .from("copilot_drafts")
          .update({ risk_flags: null, risk_checked_at: null })
          .eq("id", draft.id)
          .eq("status", "pending");
      }
      return { ok: false, error: RISK_CHECK_FAILED_MESSAGE };
    }
    if (!updated) return { ok: false, error: "This draft has already been decided." };

    const allFlags = [...result.deterministic_flags, ...result.semantic_flags];
    const highCount = allFlags.filter((f) => f.severity === "high").length;
    if (result.status === "partial") {
      const det = result.deterministic_flags.length;
      await supabase.from("copilot_audit_log").insert({
        draft_id: draft.id,
        tenant_id: draft.tenant_id,
        action: "risk_check",
        model_id: null,
        detail: {
          status: "partial",
          partial_preserved: true,
          summary: `Partial — rule checks only · ${det} rule flag${det === 1 ? "" : "s"} · language review did not run`,
          layers: result.layers.map((l) => `${l.check}:${l.status}`),
          deterministic_flags: det,
          high_severity_flags: highCount,
          not_determinable: result.not_determinable.length,
          error_code: failureCode,
        },
      });
    } else {
      await supabase.from("copilot_audit_log").insert({
        draft_id: draft.id,
        tenant_id: draft.tenant_id,
        action: "risk_check",
        model_id: modelId,
        detail: {
          layers: result.layers.map((l) => `${l.check}:${l.status}`),
          deterministic_flags: result.deterministic_flags.length,
          semantic_flags: result.semantic_flags.length,
          high_severity_flags: highCount,
          not_determinable: result.not_determinable.length,
          rejected_quotes: result.rejected_quote_count,
          malformed_flags: result.malformed_flag_count,
        },
      });
    }

    return { ok: true, result, riskCheckedAt: checkedAt };
  });

function auditSummary(action: string, detail: Json | null): string | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const d = detail as Record<string, Json | undefined>;
  // Rows may carry their own one-line summary (used by self-contained features).
  if (typeof d["summary"] === "string") return d["summary"];
  if (action === "model_error") {
    if (d["stage"] === "risk_check") return "During risk check";
    if (d["stage"] === "photo_triage") return "During photo triage";
    return "During drafting";
  }
  if (action === "approve" && d["kind"] === "work_order") return "Work order";
  if (action === "photo_triage") {
    const regions = Number(d["regions"] ?? 0);
    const found = Number(d["visible_findings"] ?? 0);
    if (d["outcome"] === "needs_clearer_photo") {
      return `${regions} region${regions === 1 ? "" : "s"} · asked for a clearer photo`;
    }
    return `${regions} region${regions === 1 ? "" : "s"} · ${found} visible finding${found === 1 ? "" : "s"}`;
  }
  if (action === "risk_check") {
    const det = Number(d["deterministic_flags"] ?? 0);
    const sem = Number(d["semantic_flags"] ?? 0);
    const nd = Number(d["not_determinable"] ?? 0);
    const rej = Number(d["rejected_quotes"] ?? 0);
    const parts = [`${det} rule flag${det === 1 ? "" : "s"}`, `${sem} AI flag${sem === 1 ? "" : "s"}`];
    if (nd) parts.push(`${nd} not determinable`);
    if (rej) parts.push(`${rej} quote${rej === 1 ? "" : "s"} rejected`);
    return parts.join(" · ");
  }
  return null;
}
