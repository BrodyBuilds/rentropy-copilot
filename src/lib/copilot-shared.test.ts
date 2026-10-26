import { describe, expect, it } from "vitest";

import { buildFacts, formatCents, type TenantRecord } from "./copilot-shared";

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
  rent_cents: 185000,
  balance_cents: 0,
  lease_late_fee_cents: 9250,
  deposit_status: "disputed",
};

const byField = (facts: ReturnType<typeof buildFacts>) =>
  Object.fromEntries(facts.map((f) => [f.field, f.value]));

describe("Facts used", () => {
  it("formats integer cents as dollars", () => {
    expect(formatCents(245000)).toBe("$2,450.00");
    expect(formatCents(12250)).toBe("$122.50");
  });

  it("late rent for Sarah uses rent, due day, balance and late fee from her record", () => {
    const facts = byField(buildFacts(sarah, "late_rent"));
    expect(facts['rent_cents']).toBe("$2,450.00");
    expect(facts['due_day']).toBe("1st of each month");
    expect(facts['balance_cents']).toBe("$2,450.00");
    expect(facts['lease_late_fee_cents']).toBe("$122.50");
  });

  it("deposit reply for James reports the disputed deposit", () => {
    expect(byField(buildFacts(james, "deposit_reply"))['deposit_status']).toBe("disputed");
  });

  it("never shows a fact that has no value in the record", () => {
    const fields = buildFacts(sarah, "move_notice").map((f) => f.field);
    expect(fields).not.toContain("termination_date");
    expect(fields).not.toContain("possession_date");
  });

  it("every fact names the tenant record field it came from", () => {
    const facts = buildFacts(sarah, "late_rent");
    for (const f of facts) expect(Object.keys(sarah)).toContain(f.field);
  });
});
