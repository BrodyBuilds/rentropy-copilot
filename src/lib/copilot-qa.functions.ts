// Slice 4: read-only landlord Q&A. One server function, one audit action ("qa").
// Reads ONLY the page tenant's row from demo_tenants (plus the other tenants'
// names and property labels, used only to refuse cross-scope questions) and writes only audit rows —
// never a draft, a message, or anything else.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { callModel, configuredModelId, ModelCallError } from "./copilot-model.server";
import {
  buildQaInput,
  fallbackAnswer,
  planAnswer,
  QA_FAILED_MESSAGE,
  QA_SYSTEM_PROMPT,
  verifyModelAnswer,
  type QaAnswer,
} from "./copilot-qa";

const QA_TENANT_COLUMNS =
  "id, full_name, property_label, lease_start, lease_end, rent_cents, due_day, balance_cents, lease_late_fee_cents, deposit_status, termination_date, possession_date";

export type AskResult =
  | { ok: true; outcome: "refused"; message: string }
  | { ok: true; outcome: "answered"; answer: QaAnswer; modelId: string | null }
  | { ok: false; error: string };

const SUMMARY: Record<QaAnswer["kind"], string> = {
  direct: "Tenant Q&A · answered from the record",
  not_in_record: "Tenant Q&A · not in the record",
  model: "Tenant Q&A · AI wording, figures checked",
  model_discarded: "Tenant Q&A · AI wording discarded, facts listed",
};

export const askAboutTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        question: z.string().trim().min(1).max(500),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<AskResult> => {
    const { supabase } = context;

    // The scope tenant's row; from every other tenant, only the name and property label (for the scope check).
    const [{ data: tenant, error: tenantError }, { data: nameRows, error: namesError }] = await Promise.all([
      supabase.from("demo_tenants").select(QA_TENANT_COLUMNS).eq("id", data.tenant_id).maybeSingle(),
      supabase.from("demo_tenants").select("id, full_name, property_label"),
    ]);
    if (tenantError || namesError) throw new Error("Could not load tenant");
    if (!tenant) return { ok: false, error: "Tenant not found." };
    const others = (nameRows ?? []).filter((r) => r.id !== tenant.id);
    const otherTenantNames = others.map((r) => r.full_name);
    const otherPropertyLabels = others.map((r) => r.property_label);

    const audit = async (action: "qa" | "model_error", modelId: string | null, detail: Record<string, unknown>) => {
      const { error } = await supabase.from("copilot_audit_log").insert({
        tenant_id: tenant.id,
        action,
        model_id: modelId,
        detail: { question: data.question, ...detail } as never,
      });
      if (error) console.error("[copilot-qa] audit insert failed", error);
      return !error;
    };

    // Other tenants' names and property labels are used only for matching here; they never reach the model.
    const plan = planAnswer(data.question, tenant, otherTenantNames, otherPropertyLabels);

    // Step 1: cross-scope questions are refused before any model call.
    if (plan.kind === "refused") {
      const logged = await audit("qa", null, {
        outcome: "refused_cross_scope",
        model_called: false,
        summary: "Tenant Q&A · refused, different tenant or property (no model called)",
      });
      if (!logged) return { ok: false, error: QA_FAILED_MESSAGE };
      return { ok: true, outcome: "refused", message: plan.message };
    }

    // Steps 2 and 4: answered in code from the row.
    if (plan.kind === "answered") {
      const logged = await audit("qa", null, {
        outcome: plan.answer.kind,
        model_called: false,
        topics: plan.topics,
        missing: plan.missing,
        fact_fields: plan.answer.facts.map((f) => f.field),
        summary: SUMMARY[plan.answer.kind],
      });
      if (!logged) return { ok: false, error: QA_FAILED_MESSAGE };
      return { ok: true, outcome: "answered", answer: plan.answer, modelId: null };
    }

    // Step 3: compound question — the model phrases, code verifies every figure.
    let reply: { text: string; modelId: string };
    try {
      reply = await callModel(QA_SYSTEM_PROMPT, buildQaInput(data.question, plan.facts), {
        temperature: 0,
      });
      if (!reply.text.trim()) throw new ModelCallError("Empty answer", reply.modelId, "invalid_output");
    } catch (error) {
      const modelId = error instanceof ModelCallError ? error.modelId : configuredModelId();
      const code = error instanceof ModelCallError ? error.code : "unknown";
      await audit("model_error", modelId, { stage: "qa", error_code: code, summary: "During tenant Q&A" });
      return { ok: false, error: QA_FAILED_MESSAGE };
    }

    const text = reply.text.trim();
    const check = verifyModelAnswer(text, plan.facts);
    const answer: QaAnswer = check.ok
      ? { kind: "model", answer: text, facts: plan.facts }
      : fallbackAnswer(plan.facts);

    const logged = await audit("qa", reply.modelId, {
      outcome: check.ok ? "model_answer" : "model_answer_discarded",
      model_called: true,
      topics: plan.topics,
      fact_fields: answer.facts.map((f) => f.field),
      ...(check.ok ? {} : { mismatched_figures: check.mismatches }),
      summary: SUMMARY[answer.kind],
    });
    if (!logged) return { ok: false, error: QA_FAILED_MESSAGE };
    return { ok: true, outcome: "answered", answer, modelId: reply.modelId };
  });
