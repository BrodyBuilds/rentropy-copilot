import { describe, expect, it } from "vitest";

import { actionLabel, describeAuditEntry, fullRecordText } from "./copilot-audit";

const value = (lines: { label: string; value: string }[], label: string) =>
  lines.find((l) => l.label === label)?.value;

describe("audit action labels", () => {
  it("labels qa as Tenant Q&A", () => {
    expect(actionLabel("qa")).toBe("Tenant Q&A");
  });
  it("labels approved_after_partial_review as Approved (partial review)", () => {
    expect(actionLabel("approved_after_partial_review")).toBe("Approved (partial review)");
  });
});

describe("photo triage entries", () => {
  const detail = {
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
  const lines = describeAuditEntry("photo_triage", "muse-spark-1.3", detail);

  it("shows both models", () => {
    expect(value(lines, "Interpretation model")).toBe("muse-spark-1.3");
    expect(value(lines, "Segmentation model")).toBe("sam-3.1");
  });
  it("shows concepts and regions per concept, including zero", () => {
    expect(value(lines, "Concepts looked for")).toBe("water stain, crack");
    expect(value(lines, "Regions found per concept")).toBe("water stain: 2 regions · crack: 0 regions");
  });
  it("shows the outcome and tone", () => {
    expect(value(lines, "Outcome")).toBe("Visible findings recorded");
    expect(value(lines, "Tone")).toBe("Friendly");
  });
});

describe("risk check entries", () => {
  it("shows a partial result as partial with the AI layer not run", () => {
    const lines = describeAuditEntry("risk_check", null, {
      status: "partial",
      partial_preserved: true,
      deterministic_flags: 0,
      not_determinable: 1,
      error_code: "timeout",
    });
    expect(value(lines, "Result")).toMatch(/^Partial/);
    expect(value(lines, "Rule flags")).toBe("0");
    expect(value(lines, "AI flags")).toBe("Not run");
    expect(value(lines, "Not determinable")).toBe("1");
    expect(value(lines, "Rejected quotes")).toBe("Not run");
  });
  it("shows a complete result with all four counts", () => {
    const lines = describeAuditEntry("risk_check", "muse-spark-1.3", {
      deterministic_flags: 2,
      semantic_flags: 1,
      not_determinable: 0,
      rejected_quotes: 3,
    });
    expect(value(lines, "Result")).toMatch(/^Complete/);
    expect(value(lines, "Rule flags")).toBe("2");
    expect(value(lines, "AI flags")).toBe("1");
    expect(value(lines, "Not determinable")).toBe("0");
    expect(value(lines, "Rejected quotes")).toBe("3");
  });
});

describe("tenant Q&A and model error entries", () => {
  it("shows the question and its outcome", () => {
    const lines = describeAuditEntry("qa", null, {
      question: "what is the rent at maple ridge?",
      outcome: "refused_cross_scope",
      model_called: false,
    });
    expect(value(lines, "Question")).toBe("what is the rent at maple ridge?");
    expect(value(lines, "Outcome")).toMatch(/^Refused/);
  });
  it("shows the stage and error code of a model error", () => {
    const lines = describeAuditEntry("model_error", "sam-3.1", {
      stage: "photo_triage",
      error_code: "segmentation_http_error",
    });
    expect(value(lines, "Stage")).toBe("Photo triage");
    expect(value(lines, "Error code")).toBe("segmentation_http_error");
  });
  it("treats a model error without a stage as drafting", () => {
    expect(value(describeAuditEntry("model_error", null, { error_code: "timeout" }), "Stage")).toBe("Drafting");
  });
});

describe("full record", () => {
  it("keeps every stored field, including ones no label covers", () => {
    const text = fullRecordText({ outcome: "findings", some_new_field: "kept" });
    expect(text).toContain('"some_new_field": "kept"');
  });
});
