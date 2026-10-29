// Client-safe, pure helpers that turn a stored audit row into plain-language lines for
// the audit page. Nothing here reads or writes data; the page also shows the full
// stored record below these lines, so nothing recorded is ever hidden.

import { CHECK_LABELS, type CheckId } from "./copilot-risk";
import { draftLanguageLabel, messageTypeLabel, toneLabel } from "./copilot-shared";

export const ACTION_LABELS: Record<string, string> = {
  generate: "Draft generated",
  model_error: "Model error",
  approve: "Approved",
  approved_after_partial_review: "Approved (partial review)",
  discard: "Discarded",
  risk_check: "Risk check",
  photo_triage: "Photo triage",
  qa: "Tenant Q&A",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export type AuditLine = { label: string; value: string };

type Detail = Record<string, unknown>;

const STAGE_LABELS: Record<string, string> = {
  risk_check: "Risk check",
  photo_triage: "Photo triage",
  qa: "Tenant Q&A",
};

const QA_OUTCOME_LABELS: Record<string, string> = {
  refused_cross_scope: "Refused — the question was about a different tenant or property (no AI called)",
  direct: "Answered directly from the record",
  not_in_record: "Not in the record",
  model_answer: "AI wording, every figure checked against the record",
  model_answer_discarded: "AI answer discarded — a figure didn't match the record",
};

const TRIAGE_OUTCOME_LABELS: Record<string, string> = {
  findings: "Visible findings recorded",
  needs_clearer_photo: "Asked the tenant for a clearer photo",
};

const LAYER_STATUS_LABELS: Record<string, string> = {
  ran: "ran",
  not_determinable: "not determinable",
  not_run: "not run",
};

/** Formats any stored value as plain text. */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    if (value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
      return value.map((v) => formatAuditValue(v)).join(", ");
    }
  }
  return JSON.stringify(value);
}

function asDetail(detail: unknown): Detail {
  return detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Detail) : {};
}

function has(d: Detail, key: string): boolean {
  return d[key] !== undefined;
}

function regionsPerConceptText(value: unknown): string {
  const d = asDetail(value);
  const entries = Object.entries(d);
  if (entries.length === 0) return "—";
  return entries
    .map(([concept, n]) => {
      const count = Number(n);
      return `${concept}: ${count} region${count === 1 ? "" : "s"}`;
    })
    .join(" · ");
}

function layersText(value: unknown): string {
  if (!Array.isArray(value)) return formatAuditValue(value);
  return value
    .map((entry) => {
      const [check, status] = String(entry).split(":");
      const label = CHECK_LABELS[check as CheckId] ?? check ?? "";
      return `${label} (${LAYER_STATUS_LABELS[status ?? ""] ?? status ?? "?"})`;
    })
    .join(", ");
}

/**
 * Plain-language lines for one audit row, by action. Fields not covered here still
 * appear in the full stored record the page renders underneath.
 */
export function describeAuditEntry(action: string, modelId: string | null, detail: unknown): AuditLine[] {
  const d = asDetail(detail);
  const lines: AuditLine[] = [];
  const add = (label: string, value: string) => lines.push({ label, value });

  if (typeof d["summary"] === "string") add("Summary", d["summary"]);

  switch (action) {
    case "photo_triage": {
      add("Interpretation model", formatAuditValue(modelId));
      add("Segmentation model", formatAuditValue(d["sam_model_id"]));
      add("Concepts looked for", formatAuditValue(d["concepts"]));
      add("Regions found per concept", regionsPerConceptText(d["regions_per_concept"]));
      if (has(d, "regions")) add("Total regions", formatAuditValue(d["regions"]));
      if (has(d, "visible_findings")) add("Visible findings", formatAuditValue(d["visible_findings"]));
      if (has(d, "dropped_findings")) {
        add("Findings removed by the honesty rules", formatAuditValue(d["dropped_findings"]));
      }
      add(
        "Outcome",
        TRIAGE_OUTCOME_LABELS[String(d["outcome"])] ?? formatAuditValue(d["outcome"]),
      );
      add("Tone", has(d, "tone") ? toneLabel(String(d["tone"])) : "—");
      break;
    }
    case "risk_check": {
      const partial = d["status"] === "partial";
      add(
        "Result",
        partial
          ? "Partial — rule checks only, the language review did not run"
          : "Complete — rule checks and language review ran",
      );
      add("Model", partial ? "None — the language review did not run" : formatAuditValue(modelId));
      add("Rule flags", formatAuditValue(d["deterministic_flags"] ?? 0));
      add("AI flags", partial ? "Not run" : formatAuditValue(d["semantic_flags"] ?? 0));
      if (has(d, "high_severity_flags")) add("High-severity flags", formatAuditValue(d["high_severity_flags"]));
      add("Not determinable", formatAuditValue(d["not_determinable"] ?? 0));
      add("Rejected quotes", partial ? "Not run" : formatAuditValue(d["rejected_quotes"] ?? 0));
      if (has(d, "malformed_flags")) add("Malformed AI flags", formatAuditValue(d["malformed_flags"]));
      if (has(d, "layers")) add("Checks", layersText(d["layers"]));
      if (partial && has(d, "error_code")) add("Language review error code", formatAuditValue(d["error_code"]));
      break;
    }
    case "qa": {
      add("Question", formatAuditValue(d["question"]));
      add("Outcome", QA_OUTCOME_LABELS[String(d["outcome"])] ?? formatAuditValue(d["outcome"]));
      if (has(d, "model_called")) add("AI called", formatAuditValue(d["model_called"]));
      if (modelId) add("Model", modelId);
      if (has(d, "topics")) add("Topics", formatAuditValue(d["topics"]));
      if (has(d, "fact_fields")) add("Facts used", formatAuditValue(d["fact_fields"]));
      if (Array.isArray(d["missing"]) && d["missing"].length > 0) {
        add("Not in the record", formatAuditValue(d["missing"]));
      }
      if (has(d, "mismatched_figures")) add("Figures that didn't match", formatAuditValue(d["mismatched_figures"]));
      break;
    }
    case "model_error": {
      const stage = typeof d["stage"] === "string" ? d["stage"] : null;
      add("Stage", stage ? (STAGE_LABELS[stage] ?? stage) : "Drafting");
      add("Error code", formatAuditValue(d["error_code"]));
      add("Model", formatAuditValue(modelId));
      if (has(d, "question")) add("Question", formatAuditValue(d["question"]));
      if (has(d, "concepts")) add("Concepts looked for", formatAuditValue(d["concepts"]));
      if (has(d, "message_type")) add("Message type", messageTypeLabel(String(d["message_type"])));
      if (has(d, "tone")) add("Tone", toneLabel(String(d["tone"])));
      if (has(d, "language")) add("Language", draftLanguageLabel(String(d["language"])));
      break;
    }
    case "generate": {
      add("Model", formatAuditValue(modelId));
      if (has(d, "message_type")) add("Message type", messageTypeLabel(String(d["message_type"])));
      if (has(d, "tone")) add("Tone", toneLabel(String(d["tone"])));
      add("Language", draftLanguageLabel(String(d["language"] ?? "en")));
      if (has(d, "fact_fields")) add("Facts given to the model", formatAuditValue(d["fact_fields"]));
      break;
    }
    case "approve":
    case "approved_after_partial_review":
    case "discard": {
      add("What was decided", d["kind"] === "work_order" ? "Work order" : "Tenant draft");
      if (has(d, "edited")) add("Edited when decided", formatAuditValue(d["edited"]));
      if (has(d, "language")) add("Language", draftLanguageLabel(String(d["language"])));
      if (has(d, "partial_review_acknowledged")) {
        add("Manual review acknowledged", formatAuditValue(d["partial_review_acknowledged"]));
      }
      break;
    }
    default: {
      if (modelId) add("Model", modelId);
    }
  }
  return lines;
}

/** The full stored detail as indented text, so every recorded field stays visible. */
export function fullRecordText(detail: unknown): string | null {
  if (detail === null || detail === undefined) return null;
  return JSON.stringify(detail, null, 2);
}
