import { describe, expect, it } from "vitest";

import {
  clearerPhotoRequest,
  conceptsFromNote,
  draftHasCost,
  findingViolation,
  interpretationSchema,
  parseJsonObject,
  screenFindings,
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
