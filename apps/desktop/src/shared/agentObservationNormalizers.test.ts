import { describe, expect, it } from "vitest";
import { compareAgentEffectFingerprints } from "./agentObservation";
import {
  agentActionEffect,
  agentActionTargetForTrace,
  agentDomEffectFingerprint,
  createAgentActionEffectTracker,
  noteAgentActionBaseline,
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

describe("action effect", () => {
  const button = { index: 1, tagName: "button", role: "button", label: "Save", text: "Save", frame };
  const field = {
    index: 2,
    tagName: "input",
    role: "textbox",
    label: "Name",
    value: "Ada",
    frame: { x: 1, y: 60, width: 120, height: 24 },
  };
  const snapshot = (overrides: Record<string, unknown> = {}) => normalizeAgentDomSnapshot({
    url: "https://app.test/",
    title: "App",
    capturedAt: "2026-09-24T00:00:00.000Z",
    scroll: { x: 0, y: 0 },
    elementCount: 2,
    elements: [button, field],
    focusKey: null,
    ...overrides,
  });
  const compare = (before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) =>
    compareAgentEffectFingerprints(agentDomEffectFingerprint(before), agentDomEffectFingerprint(after));

  it("answers unconfirmed when nothing an agent can see changed", () => {
    expect(compare(snapshot(), snapshot({ capturedAt: "2026-09-24T00:00:09.000Z" })))
      .toEqual({ status: "unconfirmed", reason: "nothing on screen changed" });
  });

  it("names the first visible change, in a fixed order", () => {
    expect(compare(snapshot(), snapshot({ url: "https://app.test/saved", title: "Saved" })))
      .toEqual({ status: "observed", reason: "the URL changed" });
    expect(compare(snapshot(), snapshot({ elements: [button, { ...field, value: "Grace" }] })))
      .toEqual({ status: "observed", reason: '1 element changed (textbox "Name")' });
    expect(compare(snapshot(), snapshot({ focusKey: "input|textbox|name||input#name" })))
      .toEqual({ status: "observed", reason: "the focused element changed" });
    expect(compare(snapshot(), snapshot({ scroll: { x: 0, y: 400 } })))
      .toEqual({ status: "observed", reason: "the view scrolled" });
    // The element list holds only interactive elements: a click that changes
    // a heading ("Count: 1") is seen through the page text.
    expect(compare(snapshot({ textKey: "a1:8" }), snapshot({ textKey: "b2:8" })))
      .toEqual({ status: "observed", reason: "the page text changed" });
  });

  it("ignores noise: reordering, sub-grid jitter, whitespace, and a spinner's value", () => {
    const spinner = { index: 3, role: "progressbar", label: "Loading", value: "10", frame };
    const before = snapshot({ elements: [button, field, spinner], elementCount: 3 });
    const after = snapshot({
      elementCount: 3,
      elements: [
        { ...spinner, value: "70" },
        { ...field, frame: { ...field.frame, x: 1.6 } },
        { ...button, text: "  Save " },
      ],
    });
    expect(compare(before, after).status).toBe("unconfirmed");
  });

  it("compares only the shared prefix of a capped list, and the totals separately", () => {
    const capped = snapshot({ elementCount: 40, elements: [button] });
    expect(compare(capped, snapshot({ elementCount: 40 })).status).toBe("unconfirmed");
    expect(compare(capped, snapshot({ elementCount: 41 })))
      .toEqual({ status: "observed", reason: "the element count changed from 40 to 41" });
  });

  it("does not count the locate's own focus or scroll-into-view as the action's effect", () => {
    const tracker = createAgentActionEffectTracker();
    noteAgentActionBaseline(tracker, {
      snapshot: { ...snapshot(), focusKey: null },
      focusKeyAfterLocate: "button|button|||button.save",
      scrolledIntoView: true,
    });
    const after = snapshot({
      focusKey: "button|button|||button.save",
      scroll: { x: 0, y: 300 },
      elements: [{ ...button, frame: { ...frame, y: 200 } }, field],
    });
    expect(agentActionEffect(tracker, { action: "click", observed: true, after }))
      .toEqual({ status: "unconfirmed", reason: "nothing on screen changed" });
  });

  it("says why it did not compare", () => {
    const tracker = createAgentActionEffectTracker();
    expect(agentActionEffect(tracker, { action: "wait", observed: true, after: snapshot() }).status).toBe("not_checked");
    expect(agentActionEffect(tracker, { action: "click", observed: false, after: null }))
      .toEqual({ status: "not_checked", reason: "no observation was taken after the action" });
    expect(agentActionEffect(tracker, { action: "click", observed: true, after: snapshot() }))
      .toEqual({ status: "not_checked", reason: "ADE could not read the page before the action" });
  });
});
