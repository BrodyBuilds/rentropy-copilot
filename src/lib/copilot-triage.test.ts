import { describe, expect, it } from "vitest";

import { TONE_VALUES } from "./copilot-shared";
import {
  buildTriageInput,
  clearerPhotoRequest,
  conceptsFromNote,
  draftHasCost,
  findingViolation,
  interpretationSchema,
  parseJsonObject,
  screenFindings,
  TRIAGE_REPLY_TONE_GUIDANCE,
  TRIAGE_SYSTEM_PROMPT,
} from "./copilot-triage";

describe("conceptsFromNote", () => {
  it("uses water stain when there is no note", () => {
    expect(conceptsFromNote("")).toEqual(["water stain"]);
    expect(conceptsFromNote(null)).toEqual(["water stain"]);
  });

  it("uses water stain when the note suggests nothing visible", () => {
    expect(conceptsFromNote("please help asap")).toEqual(["water stain"]);
  });

  it("returns single phrases in the order the note mentions them", () => {
    expect(conceptsFromNote("There's a crack by the window and it's leaking")).toEqual([
      "crack",
      "broken glass",
      "water stain",
    ]);
  });

  it("never tries more than three concepts", () => {
    const concepts = conceptsFromNote("crack, hole, rust, peeling paint and a leak");
    expect(concepts).toHaveLength(3);
    expect(concepts.every((c) => !c.includes(","))).toBe(true);
  });
});

describe("hard rules", () => {
  it("flags causes, health claims and costs in findings", () => {
    expect(findingViolation("Stain caused by a roof leak")).toBe("cause");
    expect(findingViolation("Black mold on the wall")).toBe("health");
    expect(findingViolation("Repair will cost about $200")).toBe("cost");
    expect(findingViolation("Brown stain on the ceiling near the light")).toBeNull();
  });

  it("drops rule-breaking findings and unknown region numbers", () => {
    const { kept, dropped } = screenFindings(
      [
        { what: "Brown ring-shaped stain", where: "ceiling, upper left", regions: [1, 7] },
        { what: "Mold growth", where: "corner", regions: [2] },
      ],
      new Set([1, 2]),
    );
    expect(dropped).toBe(1);
    expect(kept).toEqual([{ what: "Brown ring-shaped stain", where: "ceiling, upper left", regions: [1] }]);
  });

  it("treats a cost in a draft as a violation", () => {
    expect(draftHasCost("We'll have a plumber out; the estimate is $150.")).toBe(true);
    expect(draftHasCost("We'll arrange a visit within [time window].")).toBe(false);
  });
});

describe("clearer photo request", () => {
  it("asks for a wide shot, a close-up, and the shutoff valve if water is involved", () => {
    const body = clearerPhotoRequest("Sarah Jenkins");
    expect(body).toMatch(/^Hi Sarah,/);
    expect(body).toMatch(/wide shot/);
    expect(body).toMatch(/close-up/);
    expect(body).toMatch(/if water is involved, a photo of the shutoff valve/i);
    expect(draftHasCost(body)).toBe(false);
  });
});

describe("interpretation shape", () => {
  const valid = {
    visible_findings: [{ what: "Stain", where: "ceiling", regions: [1] }],
    not_determinable: ["Whether it is active"],
    context_questions: ["Is it still dripping?"],
    urgency_routing: { urgency: "same_day", vendor: "Plumber", why: "Visible staining" },
    drafts: { tenant_reply: "Hi Sarah", work_order_summary: "Ceiling stain" },
  };

  it("accepts exactly the five fields", () => {
    expect(interpretationSchema.safeParse(parseJsonObject("```json\n" + JSON.stringify(valid) + "\n```")).success).toBe(true);
  });

  it("rejects extra fields and unknown urgency levels", () => {
    expect(interpretationSchema.safeParse({ ...valid, diagnosis: "roof leak" }).success).toBe(false);
    expect(
      interpretationSchema.safeParse({ ...valid, urgency_routing: { ...valid.urgency_routing, urgency: "asap" } }).success,
    ).toBe(false);
  });
});

describe("reply tone", () => {
  const base = { tenantName: "Sarah Jenkins", propertyLabel: "Unit 1", note: null, regions: [], concepts: ["water stain"] };

  it("defaults the reply tone to Friendly", () => {
    expect(buildTriageInput(base)).toContain(`Reply tone (tenant_reply only): ${TRIAGE_REPLY_TONE_GUIDANCE.friendly}`);
  });

  it("passes the selected tone to the reply instructions", () => {
    expect(buildTriageInput({ ...base, tone: "formal" })).toContain(TRIAGE_REPLY_TONE_GUIDANCE.formal);
    expect(buildTriageInput({ ...base, tone: "firm_but_fair" })).toContain(TRIAGE_REPLY_TONE_GUIDANCE.firm_but_fair);
  });

  it("has guidance for exactly the three compose tones", () => {
    expect(Object.keys(TRIAGE_REPLY_TONE_GUIDANCE).sort()).toEqual([...TONE_VALUES].sort());
  });

  it("keeps the no-placeholder rule and leaves the work order out of tone", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toMatch(/NEVER include square brackets or placeholders/);
    expect(TRIAGE_SYSTEM_PROMPT).toMatch(/every rule above apply the same in every tone/);
    expect(TRIAGE_SYSTEM_PROMPT).toMatch(/reply tone never applies here/i);
    for (const g of Object.values(TRIAGE_REPLY_TONE_GUIDANCE)) expect(g).not.toMatch(/[[\]]/);
  });

  it("keeps the clearer-photo text the same whatever the tone", () => {
    expect(clearerPhotoRequest("Sarah Jenkins")).toMatch(/Thank you, and we'll follow up once we have them\.$/);
  });
});
