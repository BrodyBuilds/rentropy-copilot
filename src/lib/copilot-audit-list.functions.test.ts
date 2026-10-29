import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        (args: { data: unknown; context: unknown }) =>
          fn(args),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./copilot-model.server", () => ({
  ModelCallError: class extends Error {},
  callModel: vi.fn(),
  configuredModelId: () => "meta-test-model",
}));

import { listAudit } from "./copilot.functions";

const triageDetail = {
  triage_id: "t1",
  sam_model_id: "sam-3.1",
  concepts: ["water stain", "crack"],
  tone: "friendly",
  regions: 2,
  regions_per_concept: { "water stain": 2, crack: 0 },
  visible_findings: 1,
  dropped_findings: 0,
  outcome: "findings",
};

function supabaseReturning(rows: unknown[]) {
  const query = {
    select: () => query,
    order: () => query,
    limit: async () => ({ data: rows, error: null }),
  };
  return { from: () => query };
}

describe("listAudit", () => {
  it("returns the one-line summary and the full stored detail", async () => {
    const supabase = supabaseReturning([
      {
        id: "a1",
        created_at: "2026-10-29T10:00:00Z",
        action: "photo_triage",
        model_id: "muse-spark-1.3",
        draft_id: "d1",
        detail: triageDetail,
        tenant: { full_name: "James Carter" },
      },
    ]);
    const call = listAudit as unknown as (args: { data: unknown; context: unknown }) => Promise<
      { detail: string | null; full_detail: unknown; tenant_name: string | null }[]
    >;
    const [row] = await call({ data: undefined, context: { supabase } });
    expect(row?.detail).toBe("2 regions · 1 visible finding");
    expect(row?.full_detail).toEqual(triageDetail);
    expect(row?.tenant_name).toBe("James Carter");
  });

  it("returns null full detail when nothing was stored", async () => {
    const supabase = supabaseReturning([
      {
        id: "a2",
        created_at: "2026-10-29T10:00:00Z",
        action: "discard",
        model_id: null,
        draft_id: null,
        detail: null,
        tenant: null,
      },
    ]);
    const call = listAudit as unknown as (args: { data: unknown; context: unknown }) => Promise<
      { detail: string | null; full_detail: unknown }[]
    >;
    const [row] = await call({ data: undefined, context: { supabase } });
    expect(row?.detail).toBeNull();
    expect(row?.full_detail).toBeNull();
  });
});
