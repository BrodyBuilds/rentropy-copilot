import { describe, expect, it } from "vitest";

import {
  assembleSegmentation,
  parseSegmentationText,
  readResponsesText,
  segmentConcepts,
  StreamError,
  UnreadableResponseError,
} from "./copilot-segmentation";
import { buildTriageInput, screenFindings } from "./copilot-triage";

describe("parseSegmentationText", () => {
  it("reads named box tokens with confidence and ignores mask data", () => {
    const text = "box x1=10 y1=20 x2=110 y2=220 w=640 h=480 c=0.91 mask=AbCboxQ+/9== box x1=300 y1=40 x2=360 y2=90 w=640 h=480 mask=Zz==";
    const { boxes, unparsed } = parseSegmentationText(text);
    expect(unparsed).toBe(0);
    expect(boxes).toEqual([
      { frame: 0, x1: 10, y1: 20, x2: 110, y2: 220, w: 640, h: 480, c: 0.91 },
      { frame: 0, x1: 300, y1: 40, x2: 360, y2: 90, w: 640, h: 480, c: null },
    ]);
  });

  it("reads positional box tokens as x1 y1 x2 y2 w h c", () => {
    const { boxes } = parseSegmentationText("<box 5 6 50 60 100 100 0.5><mask 1011>");
    expect(boxes).toEqual([{ frame: 0, x1: 5, y1: 6, x2: 50, y2: 60, w: 100, h: 100, c: 0.5 }]);
  });

  it("reads JSON-style records", () => {
    const { boxes } = parseSegmentationText('{"box": {"x1": 1, "y1": 2, "x2": 3, "y2": 4, "w": 10, "h": 10, "c": 0.7}, "mask": "QQ=="}');
    expect(boxes[0]).toMatchObject({ x1: 1, y1: 2, x2: 3, y2: 4, c: 0.7 });
  });

  it("uses one line per frame, so a photo's records are frame 0", () => {
    const { boxes } = parseSegmentationText("box 0 0 5 5 10 10\nbox 1 1 6 6 10 10");
    expect(boxes.map((b) => b.frame)).toEqual([0, 1]);
  });

  it("counts boxes that are incomplete or inverted instead of inventing them", () => {
    const { boxes, unparsed } = parseSegmentationText("box x1=10 y1=10 w=100 h=100 mask=A box 50 50 10 10 100 100");
    expect(boxes).toEqual([]);
    expect(unparsed).toBe(2);
  });

  it("returns nothing for an empty reply", () => {
    expect(parseSegmentationText("")).toEqual({ boxes: [], unparsed: 0 });
  });
});

describe("readResponsesText", () => {
  it("joins streamed output_text deltas", () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"box 0 0 "}',
      'data: {"type":"response.output_text.delta","delta":"5 5 10 10"}',
      "data: [DONE]",
    ].join("\n");
    expect(readResponsesText(sse)).toBe("box 0 0 5 5 10 10");
  });

  it("prefers the done event's full text", () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      'data: {"type":"response.output_text.done","text":"full text"}',
    ].join("\n");
    expect(readResponsesText(sse)).toBe("full text");
  });

  it("throws when the stream reports a failure", () => {
    expect(() => readResponsesText('data: {"type":"response.failed"}')).toThrow(StreamError);
  });

  it("falls back to a plain JSON body", () => {
    expect(readResponsesText(JSON.stringify({ output_text: "box 1 1 2 2 4 4" }))).toBe("box 1 1 2 2 4 4");
  });

  it("reads a well-formed stream with an empty output lane as empty text (zero matches)", () => {
    const sse = [
      'data: {"type":"response.output_text.done","text":""}',
      'data: {"type":"response.completed","response":{"output":[]}}',
      "data: [DONE]",
    ].join("\n");
    expect(readResponsesText(sse)).toBe("");
    expect(readResponsesText("")).toBe("");
  });

  it("rejects a non-empty body that is not a responses reply", () => {
    expect(() => readResponsesText("<html>Bad gateway</html>")).toThrow(UnreadableResponseError);
    expect(() => readResponsesText(JSON.stringify({ unexpected: true }))).toThrow(UnreadableResponseError);
    expect(() => readResponsesText(JSON.stringify({ error: { message: "boom" } }))).toThrow(StreamError);
  });
});

describe("photo triage segmentation stage", () => {
  const EMPTY = new Error("empty_output");
  const emptyOutputModelId = (e: unknown) => (e === EMPTY ? "sam-3.1" : undefined);
  const found = { boxes: [box(10, 10, 50, 50), box(60, 60, 90, 90)], unparsed: 0, rawText: "box …", modelId: "sam-3.1" };

  function box(x1: number, y1: number, x2: number, y2: number) {
    return { frame: 0, x1, y1, x2, y2, w: 100, h: 100, c: 0.9 };
  }

  it("treats one empty concept as zero regions and keeps the other concept's regions", async () => {
    const results = await segmentConcepts(
      ["water stain", "crack"],
      async (concept) => {
        if (concept === "water stain") throw EMPTY;
        return found;
      },
      emptyOutputModelId,
    );
    const { regions, record, regionsPerConcept } = assembleSegmentation(results, null);

    expect(regionsPerConcept).toEqual({ "water stain": 0, crack: 2 });
    expect(regions.map((r) => [r.n, r.concept])).toEqual([
      [1, "crack"],
      [2, "crack"],
    ]);
    expect(record.sam_model_id).toBe("sam-3.1");
    expect(record.requests.map((r) => r.box_count)).toEqual([0, 2]);

    // The findings pass gets the found regions and may cite only those numbers.
    const input = buildTriageInput({ tenantName: "Sarah Jenkins", propertyLabel: "Unit 1", note: null, regions, concepts: ["water stain", "crack"] });
    expect(input).toMatch(/Region 1: "crack"/);
    expect(input).toMatch(/Region 2: "crack"/);
    const screened = screenFindings([{ what: "Crack", where: "wall", regions: [2, 3] }], new Set(regions.map((r) => r.n)));
    expect(screened.kept[0]?.regions).toEqual([2]);
  });

  it("still reaches the findings pass with no regions when every concept is empty", async () => {
    const results = await segmentConcepts(["water stain", "crack"], async () => { throw EMPTY; }, emptyOutputModelId);
    const { regions, regionsPerConcept } = assembleSegmentation(results, null);

    expect(regions).toEqual([]);
    expect(regionsPerConcept).toEqual({ "water stain": 0, crack: 0 });
    const input = buildTriageInput({ tenantName: "Sarah Jenkins", propertyLabel: "Unit 1", note: null, regions, concepts: ["water stain", "crack"] });
    expect(input).toMatch(/SAM located no regions for: water stain, crack/);
    const screened = screenFindings([{ what: "Stain", where: "ceiling", regions: [1] }], new Set(regions.map((r) => r.n)));
    expect(screened.kept[0]?.regions).toEqual([]);
  });

  it("rethrows genuine failures so the run fails honestly", async () => {
    const httpError = new Error("http_500");
    await expect(
      segmentConcepts(["water stain", "crack"], async (c) => {
        if (c === "crack") throw httpError;
        return found;
      }, emptyOutputModelId),
    ).rejects.toBe(httpError);
  });
});
