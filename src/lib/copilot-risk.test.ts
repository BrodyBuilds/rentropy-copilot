import { describe, expect, it } from "vitest";

import {
  applySuggestion,
  daysPastDue,
  findMoney,
  ncLateFeeCapCents,
  parseJsonArray,
  runDeterministicChecks,
  verifySemanticFlags,
} from "./copilot-risk";
import type { TenantRecord } from "./copilot-shared";

const sarah: TenantRecord = {
  id: "00000000-0000-0000-0000-000000000001",
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

const james: TenantRecord = {
  ...sarah,
  id: "00000000-0000-0000-0000-000000000002",
  full_name: "James Carter",
  property_label: "Maple Ridge",
  lease_start: "2026-05-01",
  lease_end: "2027-04-30",
  rent_cents: 185000,
  balance_cents: 0,
  lease_late_fee_cents: 9250,
  deposit_status: "disputed",
};

const othersFor = (t: TenantRecord) =>
  [sarah, james]
    .filter((x) => x.id !== t.id)
    .map((x) => ({ full_name: x.full_name, property_label: x.property_label }));

function check(tenant: TenantRecord, body: string, messageType: "late_rent" | "deposit_reply" | "renewal", today = "2026-10-26") {
  return runDeterministicChecks({ body, tenant, others: othersFor(tenant), messageType, today });
}

describe("identity binding", () => {
  it("flags a greeting that names a different tenant and suggests the bound tenant", () => {
    const r = check(sarah, "Hi James,\nYour rent is $2,450.00.", "renewal");
    const f = r.flags.find((x) => x.category === "wrong_person");
    expect(f?.quote).toBe("James");
    expect(f?.suggestion).toBe("Sarah");
  });

  it("flags another tenant's name or property anywhere in the draft", () => {
    const r = check(sarah, "Hi Sarah,\nUnlike James Carter at Maple Ridge, you are late.", "renewal");
    const quotes = r.flags.filter((x) => x.check === "identity").map((x) => x.quote);
    expect(quotes).toEqual(["James Carter", "Maple Ridge"]);
  });

  it("passes a draft addressed to the bound tenant", () => {
    const r = check(sarah, "Dear Ms. Jenkins,\nThanks for renewing at The Heights.", "renewal");
    expect(r.flags.filter((x) => x.check === "identity")).toEqual([]);
  });
});

describe("money figures", () => {
  it("parses dollar amounts to exact cents", () => {
    expect(findMoney("$2,450.00 and $122.5 and 15 dollars").map((m) => m.cents)).toEqual([
      245000, 12250, 1500,
    ]);
  });

  it("flags an amount that matches no lease field and names the correct figure", () => {
    const r = check(sarah, "Hi Sarah, your balance of $2,500.00 is due.", "renewal");
    const f = r.flags.find((x) => x.check === "money");
    expect(f?.quote).toBe("$2,500.00");
    expect(f?.suggestion).toBe("$2,450.00");
  });

  it("accepts rent, balance, and lease late fee exactly", () => {
    const r = check(sarah, "Hi Sarah, rent is $2,450.00 and the late fee is $122.50.", "renewal");
    expect(r.flags.filter((x) => x.check === "money")).toEqual([]);
  });
});

describe("NC late-fee rules", () => {
  it("caps the fee at the greater of $15 or 5% of rent", () => {
    expect(ncLateFeeCapCents(245000)).toBe(12250);
    expect(ncLateFeeCapCents(20000)).toBe(1500);
  });

  it("counts days past the most recent due day", () => {
    expect(daysPastDue("2026-10-26", 1)).toEqual({ days: 25, dueDate: "2026-10-01" });
    expect(daysPastDue("2026-10-03", 5)).toEqual({ days: 28, dueDate: "2026-09-05" });
  });

  it("flags a late fee different from the lease row", () => {
    const r = check(sarah, "Hi Sarah, a late fee of $150.00 applies.", "late_rent");
    const f = r.flags.find((x) => x.category === "late_fee_amount");
    expect(f?.quote).toBe("$150.00");
    expect(f?.suggestion).toBe("$122.50");
    expect(r.flags.some((x) => x.check === "money")).toBe(false);
  });

  it("does not treat the balance in a late-fee sentence as the fee", () => {
    const r = check(sarah, "Hi Sarah, your balance of $2,450.00 is past due and a late fee of $122.50 applies.", "late_rent");
    expect(r.flags).toEqual([]);
  });

  it("flags a late fee when the balance is zero", () => {
    const r = check(james, "Hi James, a late fee of $92.50 applies.", "late_rent");
    expect(r.flags.some((x) => x.category === "late_fee_no_balance")).toBe(true);
  });

  it("flags a late fee before rent is 5 days late", () => {
    const r = check(sarah, "Hi Sarah, a late fee of $122.50 applies.", "late_rent", "2026-10-04");
    expect(r.flags.some((x) => x.category === "late_fee_too_early")).toBe(true);
    const ok = check(sarah, "Hi Sarah, a late fee of $122.50 applies.", "late_rent", "2026-10-06");
    expect(ok.flags.some((x) => x.category === "late_fee_too_early")).toBe(false);
  });

  it("flags stacked or recurring late fees", () => {
    const r = check(sarah, "Hi Sarah, a late fee of $122.50 will be added each day.", "late_rent");
    expect(r.flags.some((x) => x.category === "late_fee_stacking")).toBe(true);
  });
});

describe("deposit clock", () => {
  it("is not determinable when termination or possession date is missing", () => {
    const r = check(james, "Hi James, we are reviewing your deposit.", "deposit_reply");
    expect(r.notDeterminable).toHaveLength(1);
    expect(r.notDeterminable[0]?.missing).toEqual(["termination date", "possession date"]);
    expect(r.layers.find((l) => l.check === "deposit_clock")?.status).toBe("not_determinable");
    expect(r.info.some((i) => i.check === "deposit_clock")).toBe(false);
  });

  it("counts 30 and 60 days from the later of termination and possession", () => {
    const t = { ...james, termination_date: "2026-11-30", possession_date: "2026-12-05" };
    const r = runDeterministicChecks({ body: "Hi James.", tenant: t, others: [], messageType: "deposit_reply", today: "2026-12-10" });
    const detail = r.info.find((i) => i.check === "deposit_clock")?.detail ?? "";
    expect(detail).toContain("January 4, 2027");
    expect(detail).toContain("February 3, 2027");
  });

  it("flags deducting for normal wear and tear but not damage beyond it", () => {
    const bad = check(james, "Hi James, we will deduct for normal wear and tear.", "deposit_reply");
    expect(bad.flags.some((x) => x.category === "wear_and_tear")).toBe(true);
    const ok = check(james, "Hi James, we only deduct for damage beyond normal wear and tear.", "deposit_reply");
    expect(ok.flags.some((x) => x.category === "wear_and_tear")).toBe(false);
  });
});

describe("semantic span verification", () => {
  const body = "Hi Sarah, pay now or we change the locks. Pay now.";

  it("keeps quotes that occur exactly once and rejects zero or multiple matches", () => {
    const items = [
      { quote: "we change the locks", category: "illegal_self_help", severity: "high", explanation: "Lockout.", suggestion: "we will follow the legal process" },
      { quote: "Pay now", category: "coercion", severity: "low", explanation: "x", suggestion: "y" },
      { quote: "we cut the water", category: "illegal_self_help", severity: "high", explanation: "x", suggestion: "y" },
      { quote: "pay now", category: "not_a_category", severity: "high", explanation: "x" },
    ];
    const r = verifySemanticFlags(items, body);
    expect(r.flags.map((f) => f.quote)).toEqual(["we change the locks"]);
    expect(r.rejected).toBe(1 + 1);
    expect(r.malformed).toBe(1);
  });

  it("applies a rewrite to just the quoted part", () => {
    const [flag] = verifySemanticFlags(
      [{ quote: "we change the locks", category: "illegal_self_help", severity: "high", explanation: "x", suggestion: "we follow the legal process" }],
      body,
    ).flags;
    expect(flag && applySuggestion(flag, body, body)).toBe(
      "Hi Sarah, pay now or we follow the legal process. Pay now.",
    );
  });

  it("reads a JSON array from a fenced reply and refuses non-arrays", () => {
    expect(parseJsonArray("```json\n[]\n```")).toEqual([]);
    expect(parseJsonArray("No issues found.")).toBeNull();
  });
});
