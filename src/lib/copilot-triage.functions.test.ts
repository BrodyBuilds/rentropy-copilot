import { beforeEach, describe, expect, it, vi } from "vitest";

// Runs the real runPhotoTriage handler with a stand-in createServerFn, auth
// middleware, model adapter and Supabase client, so failed saves can be injected.
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
    callSegmentation: vi.fn(),
    configuredModelId: () => "meta-test-model",
    configuredSamModelId: () => "sam-test-model",
    missingTriageConfig: () => [],
  };
});

import { callModel, callSegmentation } from "./copilot-model.server";
import { approveWorkOrder, runPhotoTriage, WORK_ORDER_COST_MESSAGE } from "./copilot-triage.functions";
import { TRIAGE_FAILED_MESSAGE } from "./copilot-triage";

const TENANT_ID = "00000000-0000-4000-8000-000000000002";
const TRIAGE_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";

type Op = { table: string; kind: string; payload?: unknown };
type Failures = {
  /** Fail a copilot_photo_triage update whose payload has this key ("segmentation" | "findings"). */
  triageUpdateKey?: string;
  draftInsert?: boolean;
  /** Fail audit inserts with these actions. */
  auditActions?: string[];
};

function fakeSupabase(fail: Failures = {}) {
  const ops: Op[] = [];
  const err = { message: "write failed" };
  const client = {
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: "p" }, error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/photo.jpg" }, error: null }),
      }),
    },
    from(table: string) {
      let kind = "select";
      let payload: Record<string, unknown> = {};
      const result = () => {
        if (table === "demo_tenants") {
          return {
            data: { id: TENANT_ID, full_name: "James Carter", property_label: "Maple Ridge" },
            error: null,
          };
        }
        if (table === "copilot_photo_triage" && kind === "insert") return { data: { id: TRIAGE_ID }, error: null };
        if (table === "copilot_photo_triage" && kind === "update") {
          return { data: null, error: fail.triageUpdateKey && fail.triageUpdateKey in payload ? err : null };
        }
        if (table === "copilot_drafts" && kind === "insert") {
          return fail.draftInsert ? { data: null, error: err } : { data: { id: DRAFT_ID }, error: null };
        }
        if (table === "copilot_audit_log" && kind === "insert") {
          return { data: null, error: fail.auditActions?.includes(String(payload["action"])) ? err : null };
        }
        return { data: null, error: null };
      };
      const write = (k: string) => (p: Record<string, unknown>) => {
        kind = k;
        payload = p;
        ops.push({ table, kind, payload: p });
        return b;
      };
      const b = {
        select: () => b,
        eq: () => b,
        update: write("update"),
        insert: write("insert"),
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return b;
    },
  };
  return { client, ops };
}

const INTERPRETATION = JSON.stringify({
  visible_findings: [{ what: "Brown staining on the ceiling", where: "near the corner", regions: [] }],
  not_determinable: ["What caused the staining"],
  context_questions: ["Which room is this?"],
  urgency_routing: { urgency: "within_a_few_days", vendor: "General handyman", why: "Visible staining" },
  drafts: {
    tenant_reply: "Hi James,\n\nThanks for the photo of the staining on the ceiling.\n\nThanks",
    work_order_summary: "Inspect ceiling staining near the corner.",
  },
});

function run(fail: Failures = {}) {
  const { client, ops } = fakeSupabase(fail);
  const form = new FormData();
  form.set("tenant_id", TENANT_ID);
  form.set("note", "ceiling stain");
  form.set("tone", "friendly");
  form.set("photo", new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }));
  const call = runPhotoTriage as unknown as (args: { data: unknown; context: unknown }) => Promise<unknown>;
  return { ops, result: call({ data: form, context: { supabase: client, userId: "u1" } }) };
}

const audits = (ops: Op[]) =>
  ops.filter((o) => o.table === "copilot_audit_log").map((o) => o.payload as Record<string, unknown>);
const markedFailed = (ops: Op[]) =>
  ops.some(
    (o) =>
      o.table === "copilot_photo_triage" &&
      o.kind === "update" &&
      (o.payload as Record<string, unknown>)["status"] === "failed",
  );
const errorCode = (row: Record<string, unknown> | undefined) =>
  (row?.["detail"] as Record<string, unknown> | undefined)?.["error_code"];

const mockedCallModel = vi.mocked(callModel);
const mockedSegmentation = vi.mocked(callSegmentation);

beforeEach(() => {
  mockedCallModel.mockReset();
  mockedSegmentation.mockReset();
  mockedSegmentation.mockResolvedValue({ boxes: [], unparsed: 0, rawText: "", modelId: "sam-test-model" });
  mockedCallModel.mockResolvedValue({ text: INTERPRETATION, modelId: "meta-test-model" });
});

describe("runPhotoTriage — failed saves are never silent", () => {
  it("success path is unchanged: completes with one photo_triage audit row", async () => {
    const { ops, result } = run();
    expect(await result).toEqual({ ok: true, triageId: TRIAGE_ID });
    expect(audits(ops).map((a) => a["action"])).toEqual(["photo_triage"]);
    expect(markedFailed(ops)).toBe(false);
  });

  it("a failed segmentation save fails the run: status failed, model_error audit, no interpretation call", async () => {
    const { ops, result } = run({ triageUpdateKey: "segmentation" });
    expect(await result).toEqual({ ok: false, error: TRIAGE_FAILED_MESSAGE });
    expect(markedFailed(ops)).toBe(true);
    const rows = audits(ops);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "model_error", tenant_id: TENANT_ID, model_id: "sam-test-model" });
    expect(errorCode(rows[0])).toBe("segmentation_save_failed");
    expect(mockedCallModel).not.toHaveBeenCalled();
    expect(ops.some((o) => o.table === "copilot_drafts")).toBe(false);
  });

  it("a failed findings save moves the run to failed and writes the audit row", async () => {
    const { ops, result } = run({ triageUpdateKey: "findings" });
    expect(await result).toEqual({ ok: false, error: "The triage result couldn't be saved. Please try again." });
    expect(markedFailed(ops)).toBe(true);
    const rows = audits(ops);
    expect(rows.map((a) => a["action"])).toEqual(["model_error"]);
    expect(errorCode(rows[0])).toBe("findings_save_failed");
  });

  it("a failed draft insert marks the run failed and writes the audit row", async () => {
    const { ops, result } = run({ draftInsert: true });
    expect(await result).toEqual({ ok: false, error: "The draft couldn't be saved. Please try again." });
    expect(markedFailed(ops)).toBe(true);
    const rows = audits(ops);
    expect(rows.map((a) => a["action"])).toEqual(["model_error"]);
    expect(errorCode(rows[0])).toBe("draft_save_failed");
  });

  it("a failed photo_triage audit insert reports failure, not success", async () => {
    const { ops, result } = run({ auditActions: ["photo_triage"] });
    expect(await result).toEqual({ ok: false, error: TRIAGE_FAILED_MESSAGE });
    expect(markedFailed(ops)).toBe(true);
    expect(errorCode(audits(ops).find((a) => a["action"] === "model_error"))).toBe("audit_failed");
  });
});

describe("approveWorkOrder — no cost can be added at approval", () => {
  const STORED_BODY = "Inspect ceiling staining near the corner.";

  function workOrderSupabase() {
    const ops: Op[] = [];
    const findings = { work_order: { body: STORED_BODY, status: "pending" } };
    const client = {
      from(table: string) {
        let kind = "select";
        const write = (k: string) => (p: Record<string, unknown>) => {
          kind = k;
          ops.push({ table, kind, payload: p });
          return b;
        };
        const result = () => {
          if (table === "copilot_photo_triage" && kind === "select") {
            return { data: { id: TRIAGE_ID, tenant_id: TENANT_ID, findings }, error: null };
          }
          if (table === "copilot_photo_triage" && kind === "update") return { data: { id: TRIAGE_ID }, error: null };
          return { data: null, error: null };
        };
        const b = {
          select: () => b,
          eq: () => b,
          update: write("update"),
          insert: write("insert"),
          maybeSingle: async () => result(),
          single: async () => result(),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        };
        return b;
      },
    };
    return { client, ops };
  }

  const approve = (client: unknown, body: string) =>
    (approveWorkOrder as unknown as (args: { data: unknown; context: unknown }) => Promise<unknown>)({
      data: { triage_id: TRIAGE_ID, body },
      context: { supabase: client, userId: "u1" },
    });

  it("refuses a body with a dollar amount and writes nothing", async () => {
    const { client, ops } = workOrderSupabase();
    await expect(approve(client, `${STORED_BODY} Should cost about $250.`)).rejects.toThrow(WORK_ORDER_COST_MESSAGE);
    expect(WORK_ORDER_COST_MESSAGE).toMatch(/cannot include a cost estimate/i);
    expect(ops).toHaveLength(0);
  });

  it("an unedited body approves as today", async () => {
    const { client, ops } = workOrderSupabase();
    await approve(client, STORED_BODY);
    const update = ops.find((o) => o.table === "copilot_photo_triage" && o.kind === "update")!.payload as Record<
      string,
      unknown
    >;
    expect((update["findings"] as { work_order: Record<string, unknown> }).work_order).toMatchObject({
      body: STORED_BODY,
      status: "approved",
    });
    const rows = audits(ops);
    expect(rows.map((a) => a["action"])).toEqual(["approve"]);
    expect(rows[0]["detail"]).toEqual({ kind: "work_order", triage_id: TRIAGE_ID, edited: false });
  });

  it("an edited body with no cost approves as today", async () => {
    const { client, ops } = workOrderSupabase();
    const edited = "Inspect ceiling staining near the corner of the bedroom.";
    await approve(client, edited);
    const rows = audits(ops);
    expect(rows.map((a) => a["action"])).toEqual(["approve"]);
    expect(rows[0]["detail"]).toEqual({ kind: "work_order", triage_id: TRIAGE_ID, edited: true });
  });
});
