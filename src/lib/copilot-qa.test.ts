import { describe, expect, it } from "vitest";

import {
  CROSS_SCOPE_MESSAGE,
  fallbackAnswer,
  planAnswer,
  verifyModelAnswer,
  type QaFact,
  type QaPlan,
} from "./copilot-qa";
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

function answered(plan: QaPlan) {
  if (plan.kind !== "answered") throw new Error(`expected answered, got ${plan.kind}`);
  return plan.answer;
}

const fields = (facts: QaFact[]) => facts.map((f) => [f.field, f.raw]);

describe("scope check", () => {
  it("refuses a question about another tenant by name", () => {
    expect(planAnswer("What does James Carter owe?", sarah)).toEqual({
      kind: "refused",
      message: CROSS_SCOPE_MESSAGE,
    });
  });

  it("refuses a question about another property", () => {
    expect(planAnswer("What is the rent at Maple Ridge?", sarah).kind).toBe("refused");
  });

  it("refuses questions about other or all tenants", () => {
    expect(planAnswer("Which tenants are behind on rent?", sarah).kind).toBe("refused");
    expect(planAnswer("Compare her balance to another tenant", sarah).kind).toBe("refused");
  });

  it("allows the page tenant's own name and property", () => {
    expect(planAnswer("What does Sarah owe at The Heights?", sarah).kind).not.toBe("refused");
  });
});

describe("single stored facts are answered in code", () => {
  it("balance owed for Sarah is $2,450.00 from balance_cents", () => {
    const a = answered(planAnswer("What does Sarah owe?", sarah));
    expect(a.kind).toBe("direct");
    expect(a.answer).toContain("$2,450.00");
    expect(fields(a.facts)).toEqual([["balance_cents", 245000]]);
  });

  it("James's balance is $0.00", () => {
    expect(answered(planAnswer("What's his balance?", james)).answer).toContain("$0.00");
  });

  it("monthly rent", () => {
    const a = answered(planAnswer("How much is the monthly rent?", james));
    expect(a.answer).toContain("$1,850.00");
    expect(fields(a.facts)).toEqual([["rent_cents", 185000]]);
  });

  it("rent due day is the 1st, not a rent amount", () => {
    const a = answered(planAnswer("When is rent due?", sarah));
    expect(a.kind).toBe("direct");
    expect(a.answer).toContain("1st of each month");
    expect(fields(a.facts)).toEqual([["due_day", 1]]);
  });

  it("lease late fee", () => {
    const a = answered(planAnswer("What's the late fee?", sarah));
    expect(a.answer).toContain("$122.50");
    expect(fields(a.facts)).toEqual([["lease_late_fee_cents", 12250]]);
  });

  it("deposit status", () => {
    const a = answered(planAnswer("Is the deposit disputed?", james));
    expect(a.answer).toContain("disputed");
    expect(fields(a.facts)).toEqual([["deposit_status", "disputed"]]);
  });

  it("lease start and end dates", () => {
    const a = answered(planAnswer("What are the lease dates?", sarah));
    expect(a.answer).toContain("March 1, 2026");
    expect(a.answer).toContain("February 28, 2027");
    expect(fields(a.facts)).toEqual([
      ["lease_start", "2026-03-01"],
      ["lease_end", "2027-02-28"],
    ]);
  });
});

describe("not in the record", () => {
  it("a deposit amount is not stored; only the status is shown", () => {
    const a = answered(planAnswer("How much is the deposit?", sarah));
    expect(a.kind).toBe("not_in_record");
    expect(a.answer.startsWith("Not in the record")).toBe(true);
    expect(fields(a.facts)).toEqual([["deposit_status", "held"]]);
    expect(a.answer).not.toMatch(/\$/);
  });

  it("a phone number is not stored", () => {
    const a = answered(planAnswer("What's her phone number?", sarah));
    expect(a.kind).toBe("not_in_record");
    expect(a.answer).not.toMatch(/\d{3}/);
  });

  it("no deposit deadline when termination and possession dates are empty", () => {
    const a = answered(planAnswer("When is the deposit return deadline?", james));
    expect(a.kind).toBe("not_in_record");
    expect(a.answer).toContain("no termination or possession date is recorded");
    expect(fields(a.facts)).toEqual([["deposit_status", "disputed"]]);
  });
});

describe("compound questions go to the model with only this tenant's facts", () => {
  it("balance compared with rent sends rent and balance", () => {
    const plan = planAnswer("Is her balance more than one month of rent?", sarah);
    expect(plan.kind).toBe("needs_model");
    if (plan.kind !== "needs_model") return;
    expect(plan.facts.map((f) => f.field).sort()).toEqual(["balance_cents", "full_name", "rent_cents"]);
  });
});

describe("model answer verification", () => {
  const plan = planAnswer("Is she behind, and when does the lease end?", sarah);
  const facts = plan.kind === "needs_model" ? plan.facts : [];

  it("accepts amounts and dates that match the row", () => {
    expect(facts.length).toBeGreaterThan(0);
    expect(verifyModelAnswer("Sarah owes $2,450.00 and her lease ends February 28, 2027.", facts).ok).toBe(true);
  });

  it("discards an amount that is not in the row", () => {
    const r = verifyModelAnswer("Sarah owes $2,572.50 including the late fee.", facts);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual(["$2,572.50"]);
  });

  it("discards a date that is not in the row", () => {
    expect(verifyModelAnswer("Her lease ends March 1, 2027.", facts).ok).toBe(false);
  });

  it("discards an invented relative date", () => {
    expect(verifyModelAnswer("She owes $2,450.00, due next week.", facts).ok).toBe(false);
  });

  it("fallback lists only facts from the record", () => {
    const fb = fallbackAnswer(facts);
    expect(fb.kind).toBe("model_discarded");
    expect(fb.answer).toContain("$2,450.00");
    expect(fb.answer).toContain("February 28, 2027");
  });
});
