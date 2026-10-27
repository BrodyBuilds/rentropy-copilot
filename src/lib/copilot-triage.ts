// Client-safe rules for photo triage (slice 3). Pure functions only, so the
// concept choice, the five-field answer shape, and the hard rules are testable
// and the model's output shape is never trusted.

import { z } from "zod";

import type { SegmentationBox } from "./copilot-segmentation";

export const DEFAULT_CONCEPT = "water stain";
export const MAX_CONCEPTS = 3;

// Visible things a tenant's note may point at. Each concept is ONE short phrase
// naming something a camera can see — never a cause or diagnosis.
const CONCEPT_CUES: Array<{ concept: string; cues: RegExp }> = [
  { concept: "water stain", cues: /\b(water|leak\w*|drip\w*|wet|damp|stain\w*|soak\w*)\b/i },
  { concept: "puddle", cues: /\b(puddle|pool\w*|flood\w*|standing water)\b/i },
  { concept: "crack", cues: /\b(crack\w*|split\w*|fracture\w*)\b/i },
  { concept: "hole", cues: /\b(hole|holes|dent\w*|punctur\w*)\b/i },
  { concept: "peeling paint", cues: /\b(peel\w*|flak\w*|bubbl\w*|blister\w*)\b/i },
  { concept: "dark spots", cues: /\b(mou?ld\w*|mildew|black spots?|dark spots?|spots?)\b/i },
  { concept: "rust", cues: /\b(rust\w*|corro\w*)\b/i },
  { concept: "broken glass", cues: /\b(glass|window\w*|shatter\w*)\b/i },
  { concept: "scorch mark", cues: /\b(scorch\w*|burn\w*|spark\w*|smok\w*|melt\w*)\b/i },
  { concept: "sagging ceiling", cues: /\b(sag\w*|bulg\w*|droop\w*)\b/i },
  { concept: "pipe", cues: /\b(pipe|pipes|plumbing)\b/i },
  { concept: "faucet", cues: /\b(faucet|tap)\b/i },
  { concept: "toilet", cues: /\b(toilet)\b/i },
  { concept: "electrical outlet", cues: /\b(outlet|socket|plug)\b/i },
  { concept: "missing tile", cues: /\b(tile|tiles|grout)\b/i },
  { concept: "damaged door", cues: /\b(door|hinge\w*|lock)\b/i },
];

/**
 * Up to three visible concepts drawn from the note, in the order the note
 * mentions them. Falls back to "water stain" when the note suggests nothing.
 */
export function conceptsFromNote(note: string | null | undefined): string[] {
  const text = (note ?? "").trim();
  if (!text) return [DEFAULT_CONCEPT];
  const hits = CONCEPT_CUES.map(({ concept, cues }) => {
    const m = cues.exec(text);
    return m ? { concept, at: m.index } : null;
  })
    .filter((h): h is { concept: string; at: number } => h !== null)
    .sort((a, b) => a.at - b.at);
  const concepts = [...new Set(hits.map((h) => h.concept))].slice(0, MAX_CONCEPTS);
  return concepts.length ? concepts : [DEFAULT_CONCEPT];
}

/* ---------- Stored shapes ---------- */

export type TriageRegion = SegmentationBox & { n: number; concept: string };

export type SegmentationRecord = {
  version: 1;
  sam_model_id: string;
  requests: Array<{ concept: string; raw_text: string; box_count: number; unparsed: number }>;
  regions: TriageRegion[];
};

export const URGENCY_LEVELS = [
  { value: "emergency", label: "Emergency — a person should look right away" },
  { value: "same_day", label: "Same day" },
  { value: "within_a_few_days", label: "Within a few days" },
  { value: "routine", label: "Routine" },
] as const;
export type Urgency = (typeof URGENCY_LEVELS)[number]["value"];

export function urgencyLabel(value: string): string {
  return URGENCY_LEVELS.find((u) => u.value === value)?.label ?? value;
}

export type VisibleFinding = { what: string; where: string; regions: number[] };

export type FindingsRecord = {
  version: 1;
  note: string | null;
  photo_usable: boolean;
  interpretation_model_id: string;
  visible_findings: VisibleFinding[];
  not_determinable: string[];
  context_questions: string[];
  urgency_routing: { urgency: Urgency | null; vendor: string; why: string };
  tenant_reply_draft_id: string | null;
  work_order: { body: string; status: "pending" | "approved"; approved_at: string | null } | null;
  /** Findings the model wrote that broke a hard rule and were dropped. */
  dropped_findings: number;
};

/* ---------- The five-field answer ---------- */

const str = z.string().trim();

export const interpretationSchema = z
  .object({
    visible_findings: z
      .array(
        z.object({
          what: str.min(1).max(400),
          where: str.max(300).default(""),
          regions: z.array(z.number().int()).default([]),
        }),
      )
      .max(12),
    not_determinable: z.array(str.min(1).max(400)).max(12),
    context_questions: z.array(str.min(1).max(300)).max(10),
    urgency_routing: z.object({
      urgency: z.enum(URGENCY_LEVELS.map((u) => u.value) as [Urgency, ...Urgency[]]),
      vendor: str.min(1).max(120),
      why: str.max(400).default(""),
    }),
    drafts: z.object({
      tenant_reply: str.max(3000).default(""),
      work_order_summary: str.max(3000).default(""),
    }),
  })
  .strict();

export type Interpretation = z.infer<typeof interpretationSchema>;

/** Pulls the first JSON object out of a model reply (tolerates code fences / prose). */
export function parseJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ---------- Hard rules, enforced in code ---------- */

const COST_RE = /\$\s?\d|\b(cost|costs|costing|price[ds]?|pricing|estimate[sd]?|dollars?|budget|expensive|cheap)\b/i;
const HEALTH_RE = /\b(mou?ld\w*|mildew|fung(us|al|i)|toxic|asbestos|health\w*|allerg\w*|spores?|hazardous|unsafe to breathe)\b/i;
const CAUSE_RE = /\b(caused by|cause of|due to|because of|result of|resulting from|stems? from|originat\w*|source of|coming from|leaking from)\b/i;

/** Why a visible finding breaks a hard rule, or null when it is fine. */
export function findingViolation(text: string): "cost" | "health" | "cause" | null {
  if (COST_RE.test(text)) return "cost";
  if (HEALTH_RE.test(text)) return "health";
  if (CAUSE_RE.test(text)) return "cause";
  return null;
}

/** Drafts must never estimate a cost; that would be a fake fact. */
export function draftHasCost(text: string): boolean {
  return COST_RE.test(text);
}

/**
 * Applies the hard rules to the model's findings: rule-breaking findings are
 * dropped and counted, and region numbers SAM never returned are removed.
 */
export function screenFindings(
  findings: Interpretation["visible_findings"],
  regionNumbers: Set<number>,
): { kept: VisibleFinding[]; dropped: number } {
  const kept: VisibleFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    if (findingViolation(`${f.what} ${f.where}`)) {
      dropped += 1;
      continue;
    }
    kept.push({
      what: f.what,
      where: f.where,
      regions: [...new Set(f.regions)].filter((n) => regionNumbers.has(n)),
    });
  }
  return { kept, dropped };
}

/** The only draft when the photo cannot support visible findings. */
export function clearerPhotoRequest(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] || "there";
  return `Hi ${first},

Thank you for sending the photo. Unfortunately we can't make out the problem clearly enough from it to know what's needed. Could you please send a few more photos?

- A wide shot showing the whole area
- A close-up of the problem
- If water is involved, a photo of the shutoff valve

Thank you, and we'll follow up once we have them.`;
}

/* ---------- Model prompt ---------- */

export const TRIAGE_SYSTEM_PROMPT = `You help a landlord triage ONE maintenance photo a tenant sent. You are given the photo, regions an image-segmentation model (SAM) located on it, and the tenant's note. You only write words; you never take actions.

Hard rules:
- Describe ONLY what is visible in the photo. The tenant's note is the tenant's claim, not something you observed.
- Never diagnose a cause. Do not say what caused anything or where water or damage is coming from.
- Never confirm mold, mildew, or any health or safety claim. Describe only appearance (for example "dark spotting"); whether it is mold belongs in not_determinable.
- Never estimate a cost, price, or repair effort, anywhere — not in findings, not in drafts.
- Anything the photo cannot establish goes in not_determinable or context_questions.
- Use region numbers only from the list you are given. Never invent a region.
- If the photo is too blurry, too dark, or is not a maintenance photo, return an empty visible_findings list and say why in not_determinable.

Drafts:
- tenant_reply: from the landlord to the tenant, written the way a landlord actually texts a tenant — warm, plain, and short, not like a photo-analysis report. Structure:
  1. "Hi <first name>," then thank them for the photo in one short sentence.
  2. Refer to the problem the way a person would, in a few everyday words (for example "the staining on the ceiling"). Do not narrate colors, shapes, regions, blur, or image quality; if a clearer photo would help, simply ask for one as a question.
  3. Say what happens next in one short sentence, with timing in plain words that match your urgency (emergency: "right away"; same_day: "today"; within_a_few_days: "in the next few days"; routine: "soon"). Never give a specific date, day, or clock time.
  4. Ask the most useful follow-up questions, each on its own short line.
  5. End with a plain thank-you close such as "Thanks!" and nothing after it — no signature, no name.
  NEVER include square brackets or placeholders of any kind (no [time window], no [Your name], no [anything]). Mention no money. Under 120 words. Plain text, no markdown headings.
- work_order_summary: for a vendor. The property label, what is visible and where, what is not yet known, the urgency. No tenant contact details, no cost. Under 140 words. Plain text.

Reply with ONLY one JSON object with exactly these five keys and nothing else:
{
  "visible_findings": [{ "what": "what can be seen", "where": "where in the photo", "regions": [1] }],
  "not_determinable": ["what this photo cannot establish"],
  "context_questions": ["question worth asking the tenant"],
  "urgency_routing": { "urgency": "emergency" | "same_day" | "within_a_few_days" | "routine", "vendor": "kind of vendor", "why": "one sentence, based only on what is visible" },
  "drafts": { "tenant_reply": "...", "work_order_summary": "..." }
}`;

export function buildTriageInput(args: {
  tenantName: string;
  propertyLabel: string;
  note: string | null;
  regions: TriageRegion[];
  concepts: string[];
}): string {
  const regionLines = args.regions.length
    ? args.regions
        .map(
          (r) =>
            `- Region ${r.n}: "${r.concept}", box from (${Math.round(r.x1)}, ${Math.round(r.y1)}) to (${Math.round(r.x2)}, ${Math.round(r.y2)}) on a ${Math.round(r.w)}×${Math.round(r.h)} image${r.c !== null ? `, confidence ${r.c.toFixed(2)}` : ""}`,
        )
        .join("\n")
    : `- SAM located no regions for: ${args.concepts.join(", ")}`;
  return `Tenant name: ${args.tenantName}
Property: ${args.propertyLabel}

Tenant's note: ${args.note ? `"${args.note}"` : "(no note)"}

SAM regions (concepts searched: ${args.concepts.join(", ")}):
${regionLines}

The photo is attached. Answer with the JSON object now.`;
}

export const TRIAGE_FAILED_MESSAGE = "Photo triage couldn't run just now. Please try again.";
