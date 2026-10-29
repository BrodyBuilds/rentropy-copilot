import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StoredRiskResult } from "@/lib/copilot.functions";
import {
  approvalGate,
  PARTIAL_ACK_TEXT,
  PartialAcknowledgment,
  readStoredRisk,
  RiskResults,
} from "./risk-check";

const BODY = "Hi Sarah, rent is due on the 1st. Thank you.";

function result(status: "complete" | "partial"): StoredRiskResult {
  return {
    version: 1,
    status,
    checked_body: BODY,
    checked_at: "2026-10-28T12:00:00.000Z",
    model_id: "meta-test-model",
    layers: [
      { check: "identity", layer: "deterministic", status: "ran" },
      { check: "money", layer: "deterministic", status: "ran" },
      { check: "semantic", layer: "semantic", status: status === "partial" ? "not_run" : "ran" },
    ],
    deterministic_flags: [],
    semantic_flags: [],
    not_determinable: [],
    info:
      status === "partial"
        ? [{ check: "semantic", title: "Language review could not run", detail: "Only the rule checks ran." }]
        : [],
    rejected_quote_count: 0,
    malformed_flag_count: 0,
  };
}

function renderResults(risk: StoredRiskResult, body = BODY) {
  return render(
    <RiskResults
      risk={risk}
      body={body}
      isPending
      appliedIds={new Set()}
      onApply={() => {}}
      onRetry={() => {}}
      retryDisabled={false}
      checking={false}
    />,
  );
}

describe("RiskResults", () => {
  it("renders a zero-flag partial as incomplete, never as a clean pass", () => {
    const { container } = renderResults(result("partial"));

    expect(screen.getByText("Incomplete")).toBeInTheDocument();
    expect(screen.getByText("Language review did not run - manual review required")).toBeInTheDocument();
    expect(screen.getByText("Rule checks")).toBeInTheDocument();
    expect(screen.getByText("Not run")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry language review" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/No flags from the checks that ran/);
    expect(container.textContent).not.toMatch(/No issues found/i);
    expect(container.querySelector(".bg-success")).toBeNull();
  });

  it("still shows the stale banner and the retry after a partial is edited", () => {
    renderResults(result("partial"), `${BODY} Edited.`);
    expect(screen.getByText("Draft changed since the check — run the risk check again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry language review" })).toBeInTheDocument();
  });

  it("keeps the clean-run message for a zero-flag complete check", () => {
    const { container } = renderResults(result("complete"));
    expect(container.textContent).toMatch(/No flags from the checks that ran/);
    expect(screen.queryByText("Incomplete")).toBeNull();
  });
});

describe("readStoredRisk", () => {
  it("keeps partial status and reads results saved before status existed as complete", () => {
    expect(readStoredRisk(result("partial"))?.status).toBe("partial");
    const { status: _omit, ...legacy } = result("complete");
    expect(readStoredRisk(legacy)?.status).toBe("complete");
  });
});

describe("partial acknowledgment gate", () => {
  it("keeps Approve disabled on a partial until the acknowledgment is given", () => {
    expect(approvalGate({ partial: true, partialAcknowledged: false, highCount: 0, highConfirmed: false }).approveEnabled).toBe(false);
    expect(approvalGate({ partial: true, partialAcknowledged: true, highCount: 0, highConfirmed: false }).approveEnabled).toBe(true);
  });

  it("does not ask for the acknowledgment on a complete check", () => {
    expect(approvalGate({ partial: false, partialAcknowledged: false, highCount: 0, highConfirmed: false }).approveEnabled).toBe(true);
  });

  it("requires both acknowledgments when a partial also has high-severity flags", () => {
    const notAcked = approvalGate({ partial: true, partialAcknowledged: false, highCount: 1, highConfirmed: false });
    expect(notAcked.approveEnabled).toBe(false);
    const acked = approvalGate({ partial: true, partialAcknowledged: true, highCount: 1, highConfirmed: false });
    expect(acked.approveEnabled).toBe(true);
    expect(acked.needsHighConfirm).toBe(true);
    const both = approvalGate({ partial: true, partialAcknowledged: true, highCount: 1, highConfirmed: true });
    expect(both.needsHighConfirm).toBe(false);
  });

  it("shows the exact acknowledgment wording and reports when it is ticked", () => {
    const onChange = vi.fn();
    render(<PartialAcknowledgment checked={false} onChange={onChange} />);
    expect(screen.getByText(PARTIAL_ACK_TEXT)).toBeInTheDocument();
    expect(PARTIAL_ACK_TEXT).toBe(
      "I understand the rule checks ran but the language review could not run, and I have reviewed this draft myself",
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
