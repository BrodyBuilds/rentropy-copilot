import { beforeEach, describe, expect, it, vi } from "vitest";

// Run the real server-function handlers with a stand-in createServerFn and auth middleware.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (input: unknown) => unknown = (x) => x;
    const builder = {
      middleware: () => builder,
      validator: (fn: (input: unknown) => unknown) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        (args: { data: unknown; context: unknown }) =>
          fn({ data: validate(args.data), context: args.context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./copilot-model.server", () => {
  class ModelCallError extends Error {
    constructor(
      message: string,
      readonly modelId: string | null,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    ModelCallError,
    callModel: vi.fn(),
    configuredModelId: () => "meta-test-model",
  };
});

import { callModel, ModelCallError } from "./copilot-model.server";
import {
  copilotDraft,
  DECISION_AUDIT_FAILED_MESSAGE,
  decideDraft,
  RISK_CHECK_FAILED_MESSAGE,
  runRiskCheck,
} from "./copilot.functions";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const SARAH_ID = "00000000-0000-4000-8000-000000000001";

const sarah = {
  id: SARAH_ID,
  full_name: "Sarah Jenkins",
  property_label: "The Heights",
  lease_start: "2026-03-01",
  lease_end: "2027-02-28",
  rent_cents: 245000,
  due_day: 1,
  balance_cents: 245000,
  lease_late_fee_cents: 12250,
  deposit_status: "held",
  termination_date: null,
  possession_date: null,
};

type Op = { table: string; kind: string; payload?: unknown };

/** A tiny stand-in for the Supabase client that records writes. */
function fakeSupabase(opts: {
  draft: Record<string, unknown>;
  generateDetail?: Record<string, unknown>;
  /** Audit inserts with these actions return an error, as supabase-js does (no throw). */
  failAuditActions?: string[];
}) {
  const ops: Op[] = [];
  const client = {
    from(table: string) {
      let kind = "select";
      let payload: unknown;
      let neq = false;
      const result = () => {
        if (kind === "insert") {
          if (table === "copilot_drafts") return { data: { id: DRAFT_ID, ...(payload as object) }, error: null };
          const action = String((payload as Record<string, unknown>)["action"]);
          if (table === "copilot_audit_log" && opts.failAuditActions?.includes(action)) {
            return { data: null, error: { message: "insert failed" } };
          }
          return { data: null, error: null };
        }
        if (table === "copilot_audit_log") {
          return { data: opts.generateDetail ? { detail: opts.generateDetail } : null, error: null };
        }
        if (table === "demo_tenants") return { data: neq ? [] : sarah, error: null };
        if (table === "copilot_drafts" && kind === "update") {
          return { data: { ...opts.draft, ...(payload as object) }, error: null };
        }
        return { data: opts.draft, error: null };
      };
      const b = {
        select: () => b,
        eq: () => b,
        neq: () => {
          neq = true;
          return b;
        },
        update: (p: unknown) => {
          kind = "update";
          payload = p;
          ops.push({ table, kind, payload: p });
          return b;
        },
        insert: (p: unknown) => {
          kind = "insert";
          payload = p;
          ops.push({ table, kind, payload: p });
          return b;
        },
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return b;
    },
  };
  return { client, ops };
}

const mockedCallModel = vi.mocked(callModel);

beforeEach(() => {
  mockedCallModel.mockReset();
});

// $500.00 is not on Sarah's lease row, so the money rule check flags it.
const BODY = "Hi Sarah Jenkins, your balance of $500.00 is now past due. Thank you.";

function pendingDraft(extra: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    tenant_id: SARAH_ID,
    status: "pending",
    message_type: "late_rent",
    draft_body: BODY,
    risk_flags: null,
    ...extra,
  };
}

describe("runRiskCheck — language review fails", () => {
  it("keeps the rule-check results as a partial result instead of clearing them", async () => {
    mockedCallModel.mockRejectedValue(new ModelCallError("timed out", "meta-test-model", "timeout"));
    const { client, ops } = fakeSupabase({ draft: pendingDraft() });

    const res = await runRiskCheck({
      data: { draft_id: DRAFT_ID, draft_body: BODY },
      context: { supabase: client, userId: "u1" },
    } as never);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.status).toBe("partial");
    expect(res.result.deterministic_flags.length).toBeGreaterThan(0);
    expect(res.result.semantic_flags).toEqual([]);
    expect(res.result.layers.find((l) => l.check === "semantic")?.status).toBe("not_run");
    expect(res.result.info.some((i) => i.title === "Language review could not run")).toBe(true);

    const updates = ops.filter((o) => o.table === "copilot_drafts" && o.kind === "update");
    expect(updates).toHaveLength(1);
    const saved = updates[0]!.payload as { risk_flags: { status: string }; risk_checked_at: string | null };
    expect(saved.risk_flags.status).toBe("partial");
    expect(saved.risk_checked_at).toBe(res.riskCheckedAt);

    const audits = ops.filter((o) => o.table === "copilot_audit_log").map((o) => o.payload as Record<string, unknown>);
    expect(audits[0]).toEqual({
      draft_id: DRAFT_ID,
      tenant_id: SARAH_ID,
      action: "model_error",
      model_id: "meta-test-model",
      detail: { stage: "risk_check", error_code: "timeout" },
    });
    expect(audits[1]!["action"]).toBe("risk_check");
    const detail = audits[1]!["detail"] as Record<string, unknown>;
    expect(detail["partial_preserved"]).toBe(true);
    expect(detail["deterministic_flags"]).toBe(res.result.deterministic_flags.length);
  });

  it("stores status complete when the language review succeeds", async () => {
    mockedCallModel.mockResolvedValue({ text: "[]", modelId: "meta-test-model" });
    const { client } = fakeSupabase({ draft: pendingDraft() });

    const res = await runRiskCheck({
      data: { draft_id: DRAFT_ID, draft_body: BODY },
      context: { supabase: client, userId: "u1" },
    } as never);

    expect(res.ok && res.result.status).toBe("complete");
    expect(res.ok && res.result.layers.find((l) => l.check === "semantic")?.status).toBe("ran");
  });
});

describe("model call timeouts", () => {
  it("passes timeoutMs 60000 to the risk-check language review", async () => {
    mockedCallModel.mockResolvedValue({ text: "[]", modelId: "meta-test-model" });
    const { client } = fakeSupabase({ draft: pendingDraft() });

    await runRiskCheck({
      data: { draft_id: DRAFT_ID, draft_body: BODY },
      context: { supabase: client, userId: "u1" },
    } as never);

    expect(mockedCallModel).toHaveBeenCalledTimes(1);
    expect(mockedCallModel.mock.calls[0]![2]).toMatchObject({ timeoutMs: 60000, temperature: 0 });
  });

  it("leaves drafting on the adapter default (no per-call timeout)", async () => {
    mockedCallModel.mockResolvedValue({ text: "Hi Sarah", modelId: "meta-test-model" });
    const { client } = fakeSupabase({ draft: pendingDraft() });

    await copilotDraft({
      data: { tenant_id: SARAH_ID, message_type: "late_rent", tone: "friendly" },
      context: { supabase: client, userId: "u1" },
    } as never);

    expect(mockedCallModel).toHaveBeenCalledTimes(1);
    const options = mockedCallModel.mock.calls[0]![2] as { timeoutMs?: number } | undefined;
    expect(options?.timeoutMs).toBeUndefined();
  });
});

describe("decideDraft — partial acknowledgment gate", () => {
  const partialFlags = { version: 1, status: "partial", checked_body: BODY };

  it("refuses to approve a partial without the acknowledgment and writes nothing", async () => {
    const { client, ops } = fakeSupabase({ draft: pendingDraft({ risk_flags: partialFlags }) });

    await expect(
      decideDraft({
        data: { draft_id: DRAFT_ID, decision: "approve", draft_body: BODY },
        context: { supabase: client, userId: "u1" },
      } as never),
    ).rejects.toThrow(/language review did not run/i);
    expect(ops).toHaveLength(0);
  });

  it("records approved_after_partial_review when acknowledged", async () => {
    const { client, ops } = fakeSupabase({ draft: pendingDraft({ risk_flags: partialFlags }) });

    await decideDraft({
      data: { draft_id: DRAFT_ID, decision: "approve", draft_body: BODY, partial_review_acknowledged: true },
      context: { supabase: client, userId: "u1" },
    } as never);

    const audit = ops.find((o) => o.table === "copilot_audit_log")!.payload as Record<string, unknown>;
    expect(audit["action"]).toBe("approved_after_partial_review");
  });

  it("approves a complete result as a plain approve, with no acknowledgment needed", async () => {
    const { client, ops } = fakeSupabase({
      draft: pendingDraft({ risk_flags: { ...partialFlags, status: "complete" } }),
    });

    await decideDraft({
      data: { draft_id: DRAFT_ID, decision: "approve", draft_body: BODY },
      context: { supabase: client, userId: "u1" },
    } as never);

    const audit = ops.find((o) => o.table === "copilot_audit_log")!.payload as Record<string, unknown>;
    expect(audit["action"]).toBe("approve");
  });
});

describe("decideDraft — edits at approval clear the stale risk result", () => {
  const checked = {
    risk_flags: { version: 1, status: "complete", checked_body: BODY },
    risk_checked_at: "2026-10-29T12:00:00.000Z",
  };
  const draftUpdate = (ops: Op[]) =>
    ops.find((o) => o.table === "copilot_drafts" && o.kind === "update")!.payload as Record<string, unknown>;

  it("an edited approval ends with null risk_flags and null risk_checked_at", async () => {
    const { client, ops } = fakeSupabase({ draft: pendingDraft(checked) });
    const editedBody = "Hi Sarah Jenkins, a gentle reminder that rent is due. Thank you.";

    const updated = (await decideDraft({
      data: { draft_id: DRAFT_ID, decision: "approve", draft_body: editedBody },
      context: { supabase: client, userId: "u1" },
    } as never)) as Record<string, unknown>;

    const payload = draftUpdate(ops);
    expect(payload).toMatchObject({ status: "approved", draft_body: editedBody, risk_flags: null, risk_checked_at: null });
    expect(updated["risk_flags"]).toBeNull();
    expect(updated["risk_checked_at"]).toBeNull();
    const audit = ops.find((o) => o.table === "copilot_audit_log")!.payload as Record<string, unknown>;
    expect(audit["action"]).toBe("approve");
    expect((audit["detail"] as Record<string, unknown>)["edited"]).toBe(true);
  });

  it("an unedited approval keeps the stored risk result", async () => {
    const { client, ops } = fakeSupabase({ draft: pendingDraft(checked) });

    await decideDraft({
      data: { draft_id: DRAFT_ID, decision: "approve", draft_body: BODY },
      context: { supabase: client, userId: "u1" },
    } as never);

    const payload = draftUpdate(ops);
    expect("risk_flags" in payload).toBe(false);
    expect("risk_checked_at" in payload).toBe(false);
  });

  it("an edited approval of a partial still needs the acknowledgment, then clears the result", async () => {
    const partial = { risk_flags: { version: 1, status: "partial", checked_body: BODY }, risk_checked_at: checked.risk_checked_at };
    const editedBody = "Hi Sarah Jenkins, rent is due on the 1st. Thank you.";

    const first = fakeSupabase({ draft: pendingDraft(partial) });
    await expect(
      decideDraft({
        data: { draft_id: DRAFT_ID, decision: "approve", draft_body: editedBody },
        context: { supabase: first.client, userId: "u1" },
      } as never),
    ).rejects.toThrow(/language review did not run/i);
    expect(first.ops).toHaveLength(0);

    const second = fakeSupabase({ draft: pendingDraft(partial) });
    await decideDraft({
      data: { draft_id: DRAFT_ID, decision: "approve", draft_body: editedBody, partial_review_acknowledged: true },
      context: { supabase: second.client, userId: "u1" },
    } as never);
    expect(draftUpdate(second.ops)).toMatchObject({ risk_flags: null, risk_checked_at: null });
    const audit = second.ops.find((o) => o.table === "copilot_audit_log")!.payload as Record<string, unknown>;
    expect(audit["action"]).toBe("approved_after_partial_review");
  });

  it("discard never touches the risk result", async () => {
    const { client, ops } = fakeSupabase({ draft: pendingDraft(checked) });

    await decideDraft({
      data: { draft_id: DRAFT_ID, decision: "discard", draft_body: "Something else entirely." },
      context: { supabase: client, userId: "u1" },
    } as never);

    const payload = draftUpdate(ops);
    expect(payload["status"]).toBe("discarded");
    expect("risk_flags" in payload).toBe(false);
    expect("draft_body" in payload).toBe(false);
  });
});

describe("draft language (compose flow)", () => {
  const prompts = () => mockedCallModel.mock.calls.map((c) => c[1] as string);
  const audits = (ops: Op[]) =>
    ops.filter((o) => o.table === "copilot_audit_log").map((o) => o.payload as Record<string, unknown>);

  it("defaults to English, with no Spanish instruction, and records en on the generate row", async () => {
    mockedCallModel.mockResolvedValue({ text: "Hi Sarah", modelId: "meta-test-model" });
    const { client, ops } = fakeSupabase({ draft: pendingDraft() });

    const res = await copilotDraft({
      data: { tenant_id: SARAH_ID, message_type: "late_rent", tone: "friendly" },
      context: { supabase: client, userId: "u1" },
    } as never);

    expect(res.ok && res.language).toBe("en");
    expect(prompts()[0]).not.toMatch(/Spanish/);
    expect((audits(ops)[0]!["detail"] as Record<string, unknown>)["language"]).toBe("en");
  });

  it("Spanish asks the model for Spanish using exactly the same tenant facts", async () => {
    mockedCallModel.mockResolvedValue({ text: "Hola Sarah", modelId: "meta-test-model" });
    const { client, ops } = fakeSupabase({ draft: pendingDraft() });
    const base = { tenant_id: SARAH_ID, message_type: "late_rent", tone: "friendly" };

    await copilotDraft({ data: base, context: { supabase: client, userId: "u1" } } as never);
    const res = await copilotDraft({
      data: { ...base, language: "es" },
      context: { supabase: client, userId: "u1" },
    } as never);

    const [english, spanish] = prompts();
    expect(spanish).toMatch(/Write the entire message in Spanish/);
    const factLines = (p: string) => p.split("\n").filter((l) => l.startsWith("- "));
    expect(factLines(spanish!)).toEqual(factLines(english!));
    expect(factLines(spanish!).join("\n")).not.toMatch(/James|Maple Ridge/);
    expect(res.ok && res.language).toBe("es");
    const generate = audits(ops).filter((a) => a["action"] === "generate");
    expect((generate[1]!["detail"] as Record<string, unknown>)["language"]).toBe("es");
  });

  it("records Spanish on a failed drafting attempt's model_error row", async () => {
    mockedCallModel.mockRejectedValue(new ModelCallError("down", "meta-test-model", "http_error"));
    const { client, ops } = fakeSupabase({ draft: pendingDraft() });

    const res = await copilotDraft({
      data: { tenant_id: SARAH_ID, message_type: "late_rent", tone: "friendly", language: "es" },
      context: { supabase: client, userId: "u1" },
    } as never);

    expect(res.ok).toBe(false);
    expect(ops.some((o) => o.table === "copilot_drafts")).toBe(false);
    const row = audits(ops)[0]!;
    expect(row["action"]).toBe("model_error");
    expect((row["detail"] as Record<string, unknown>)["language"]).toBe("es");
  });

  it("approve and discard record the draft's language from its generate row", async () => {
    for (const decision of ["approve", "discard"] as const) {
      const { client, ops } = fakeSupabase({ draft: pendingDraft(), generateDetail: { language: "es" } });
      await decideDraft({
        data: { draft_id: DRAFT_ID, decision, ...(decision === "approve" ? { draft_body: BODY } : {}) },
        context: { supabase: client, userId: "u1" },
      } as never);
      const row = audits(ops)[0]!;
      expect(row["action"]).toBe(decision);
      expect(row["detail"]).toEqual({ edited: false, language: "es" });
    }
  });

  it("risk check runs unchanged on Spanish text: rule checks flag a wrong amount, language review gets the draft as-is", async () => {
    const spanishBody = "Hola Sarah Jenkins, su saldo de $500.00 está vencido. Gracias.";
    mockedCallModel.mockResolvedValue({ text: "[]", modelId: "meta-test-model" });
    const { client } = fakeSupabase({ draft: pendingDraft({ draft_body: spanishBody }) });

    const res = await runRiskCheck({
      data: { draft_id: DRAFT_ID, draft_body: spanishBody },
      context: { supabase: client, userId: "u1" },
    } as never);

    expect(res.ok && res.result.deterministic_flags.some((f) => f.quote === "$500.00")).toBe(true);
    expect(prompts()[0]).toContain(spanishBody);
  });
});

describe("failed audit inserts are never reported as success", () => {
  const ctx = (client: unknown) => ({ supabase: client, userId: "u1" });

  it("drafting: a failed generate audit row returns the save failure, not the draft", async () => {
    mockedCallModel.mockResolvedValue({ text: "Hi Sarah", modelId: "meta-test-model" });
    const { client } = fakeSupabase({ draft: pendingDraft(), failAuditActions: ["generate"] });

    const res = await copilotDraft({
      data: { tenant_id: SARAH_ID, message_type: "late_rent", tone: "friendly" },
      context: ctx(client),
    } as never);

    expect(res).toEqual({ ok: false, error: "The draft couldn't be saved. Please try again." });
  });

  it("drafting: a failed model_error audit row still returns the plain failure", async () => {
    mockedCallModel.mockRejectedValue(new ModelCallError("down", "meta-test-model", "http_error"));
    const { client } = fakeSupabase({ draft: pendingDraft(), failAuditActions: ["model_error"] });

    const res = await copilotDraft({
      data: { tenant_id: SARAH_ID, message_type: "late_rent", tone: "friendly" },
      context: ctx(client),
    } as never);

    expect(res.ok).toBe(false);
  });

  it("approve/discard: a failed decision audit row throws instead of returning the draft", async () => {
    for (const action of ["approve", "discard"] as const) {
      const { client } = fakeSupabase({ draft: pendingDraft(), failAuditActions: [action] });
      await expect(
        decideDraft({
          data: { draft_id: DRAFT_ID, decision: action, ...(action === "approve" ? { draft_body: BODY } : {}) },
          context: ctx(client),
        } as never),
      ).rejects.toThrow(DECISION_AUDIT_FAILED_MESSAGE);
    }
  });

  it("approve after partial review: a failed audit row throws", async () => {
    const { client } = fakeSupabase({
      draft: pendingDraft({ risk_flags: { version: 1, status: "partial", checked_body: BODY } }),
      failAuditActions: ["approved_after_partial_review"],
    });
    await expect(
      decideDraft({
        data: { draft_id: DRAFT_ID, decision: "approve", draft_body: BODY, partial_review_acknowledged: true },
        context: ctx(client),
      } as never),
    ).rejects.toThrow(DECISION_AUDIT_FAILED_MESSAGE);
  });

  it("risk check: a failed risk_check audit row fails the check and clears the stored result", async () => {
    mockedCallModel.mockResolvedValue({ text: "[]", modelId: "meta-test-model" });
    const { client, ops } = fakeSupabase({ draft: pendingDraft(), failAuditActions: ["risk_check"] });

    const res = await runRiskCheck({ data: { draft_id: DRAFT_ID, draft_body: BODY }, context: ctx(client) } as never);

    expect(res).toEqual({ ok: false, error: RISK_CHECK_FAILED_MESSAGE });
    const updates = ops.filter((o) => o.table === "copilot_drafts" && o.kind === "update");
    expect(updates.at(-1)!.payload).toEqual({ risk_flags: null, risk_checked_at: null });
  });

  it("risk check: a failed risk_check audit row on a partial also fails and clears", async () => {
    mockedCallModel.mockRejectedValue(new ModelCallError("timed out", "meta-test-model", "timeout"));
    const { client, ops } = fakeSupabase({ draft: pendingDraft(), failAuditActions: ["risk_check"] });

    const res = await runRiskCheck({ data: { draft_id: DRAFT_ID, draft_body: BODY }, context: ctx(client) } as never);

    expect(res).toEqual({ ok: false, error: RISK_CHECK_FAILED_MESSAGE });
    const updates = ops.filter((o) => o.table === "copilot_drafts" && o.kind === "update");
    expect(updates.at(-1)!.payload).toEqual({ risk_flags: null, risk_checked_at: null });
  });

  it("risk check: a failed model_error audit row fails the check and saves no partial result", async () => {
    mockedCallModel.mockRejectedValue(new ModelCallError("timed out", "meta-test-model", "timeout"));
    const { client, ops } = fakeSupabase({ draft: pendingDraft(), failAuditActions: ["model_error"] });

    const res = await runRiskCheck({ data: { draft_id: DRAFT_ID, draft_body: BODY }, context: ctx(client) } as never);

    expect(res).toEqual({ ok: false, error: RISK_CHECK_FAILED_MESSAGE });
    expect(ops.some((o) => o.table === "copilot_drafts" && o.kind === "update")).toBe(false);
    expect(ops.filter((o) => o.table === "copilot_audit_log").map((o) => (o.payload as { action: string }).action)).toEqual([
      "model_error",
    ]);
  });
});
