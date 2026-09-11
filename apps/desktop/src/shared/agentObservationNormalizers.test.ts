import { describe, expect, it } from "vitest";
import {
  agentActionTargetForTrace,
  agentElementLocatePayload,
  agentHasElementTarget,
  applyAgentObservationHandles,
  normalizeAgentDomSnapshot,
  normalizeAgentElementSnapshot,
  normalizeAgentFrame,
} from "./agentObservationNormalizers";

const frame = { x: 1, y: 2, width: 30, height: 40 };

describe("agent observation normalizers", () => {
  it("drops zero-area elements and derives a center from the frame", () => {
    expect(normalizeAgentElementSnapshot({ index: 1, frame: { ...frame, width: 0 } })).toBeNull();
    expect(normalizeAgentElementSnapshot({ index: 2, frame, selector: " button.save " })).toMatchObject({
      index: 2,
      selector: "button.save",
      center: { x: 16, y: 22 },
      disabled: null,
    });
  });

  it("coerces a hostile CDP payload into a well-formed snapshot", () => {
    expect(normalizeAgentFrame({ x: "nope", width: -5 })).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    const dom = normalizeAgentDomSnapshot({
      url: "https://app.test/",
      elements: [
        { index: 1, frame, framePath: [0, -1, 2], shadowPath: ["", "host"] },
        "not an element",
      ],
    });
    expect(dom?.elementCount).toBe(1);
    expect(dom?.elements[0]).toMatchObject({ framePath: [0, 2], shadowPath: ["host"] });
    expect(normalizeAgentDomSnapshot("nope")).toBeNull();
  });

  it("stamps obs-…:e:N handles onto a fresh snapshot", () => {
    const dom = normalizeAgentDomSnapshot({ elements: [{ index: 1, frame }, { index: 2, frame }] })!;
    const stamped = applyAgentObservationHandles(dom, "obs-1-abc");
    expect(stamped.elements.map((element) => element.handle)).toEqual(["obs-1-abc:e:1", "obs-1-abc:e:2"]);
  });

  it("recognises every element-target form and forwards only the locator keys", () => {
    expect(agentHasElementTarget({})).toBe(false);
    expect(agentHasElementTarget({ handle: "obs-1:e:1" })).toBe(true);
    expect(agentHasElementTarget({ elementIndex: 0 })).toBe(false);
    expect(agentElementLocatePayload({ selector: "a", text: " hi ", handle: "obs-1:e:1", elementIndex: 3 }))
      .toEqual({ selector: "a", text: "hi", elementIndex: 3 });
  });
});

describe("agent trace target redaction", () => {
  // The forked copies keyed on different action names — `typeText` in the
  // browser, `type` in App Control — so typing an API key wrote a length on one
  // surface and the key itself on the other.
  it("reduces typed text to a length under either surface's action name", () => {
    for (const action of ["type", "typeText"]) {
      const target = agentActionTargetForTrace(action, { text: "sk-live-secret", selector: "#token" });
      expect(target).toEqual({ selector: "#token", textLength: 14 });
    }
  });

  it("keeps free text for actions that are not keystrokes, capped at 300 chars", () => {
    const target = agentActionTargetForTrace("click", { text: "x".repeat(400) });
    expect(target?.text).toHaveLength(300);
    expect(target?.textLength).toBeUndefined();
  });

  it("reduces a fill value to a length and never copies the value", () => {
    expect(agentActionTargetForTrace("fill", { value: "hunter2", selector: "#pw" }))
      .toEqual({ selector: "#pw", valueLength: 7 });
  });

  it("copies surface-specific keys and lets decorate have the last word", () => {
    const target = agentActionTargetForTrace("uploadFile", { paths: ["/a", "/b"], toX: 5, mobile: true }, {
      numberKeys: ["toX"],
      booleanKeys: ["mobile"],
      decorate: (bag, { input }) => {
        bag.pathCount = (input.paths as unknown[]).length;
      },
    });
    expect(target).toEqual({ toX: 5, mobile: true, pathCount: 2 });
  });

  it("returns null rather than an empty bag", () => {
    expect(agentActionTargetForTrace("wait", {})).toBeNull();
  });
});
