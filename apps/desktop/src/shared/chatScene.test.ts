import { describe, expect, it } from "vitest";
import {
  buildSceneDocument,
  isSceneParseFailure,
  parseSceneFence,
  parseSceneHostMessage,
  SCENE_CONTENT_SECURITY_POLICY,
  SCENE_LIMITS,
} from "./chatScene";

describe("parseSceneFence", () => {
  it("reads the title off the marker line and keeps the markup", () => {
    const parsed = parseSceneFence('<!-- @scene title="Merged PRs" -->\n<div id="n">3</div>');
    if (isSceneParseFailure(parsed)) throw new Error("expected a scene");
    expect(parsed.title).toBe("Merged PRs");
    expect(parsed.html).toBe('<div id="n">3</div>');
  });

  it("works without a marker", () => {
    const parsed = parseSceneFence("<p>hello</p>");
    if (isSceneParseFailure(parsed)) throw new Error("expected a scene");
    expect(parsed.title).toBeNull();
    expect(parsed.html).toBe("<p>hello</p>");
  });

  /**
   * Models emit anything from a fragment to a full document. Both must end up
   * as a fragment so the host template keeps ownership of <head> — which is
   * where the policy lives.
   */
  it("unwraps a full document down to a fragment", () => {
    const parsed = parseSceneFence(
      '<!doctype html><html><head><style>p{color:red}</style></head><body><p>hi</p></body></html>',
    );
    if (isSceneParseFailure(parsed)) throw new Error("expected a scene");
    expect(parsed.html).not.toContain("<html");
    expect(parsed.html).not.toContain("<body");
    expect(parsed.html).toContain("<style>p{color:red}</style>");
    expect(parsed.html).toContain("<p>hi</p>");
  });

  /** A scene may not widen the policy it runs under. */
  it("strips a base tag and any policy the scene tried to declare", () => {
    const parsed = parseSceneFence(
      '<base href="https://evil.test/">\n<meta http-equiv="Content-Security-Policy" content="default-src *">\n<p>x</p>',
    );
    if (isSceneParseFailure(parsed)) throw new Error("expected a scene");
    expect(parsed.html).not.toContain("<base");
    expect(parsed.html.toLowerCase()).not.toContain("content-security-policy");
  });

  it("refuses an empty scene and an oversized one", () => {
    const empty = parseSceneFence('<!-- @scene title="x" -->\n   ');
    expect(isSceneParseFailure(empty) && empty.reason).toBe("empty");
    const big = parseSceneFence("x".repeat(SCENE_LIMITS.maxSourceBytes + 1));
    expect(isSceneParseFailure(big) && big.reason).toBe("too-large");
  });
});

describe("buildSceneDocument", () => {
  it("puts the policy first in head, before any markup can parse", () => {
    const doc = buildSceneDocument({ html: "<p>x</p>", title: "T" });
    const policyAt = doc.indexOf("Content-Security-Policy");
    const bodyAt = doc.indexOf("<body>");
    expect(policyAt).toBeGreaterThan(-1);
    expect(policyAt).toBeLessThan(bodyAt);
    expect(doc).toContain(SCENE_CONTENT_SECURITY_POLICY);
  });

  /**
   * The whole containment story in one assertion: a scene cannot reach the
   * network, so nothing it is shown can leave the frame.
   */
  it("forbids every network route", () => {
    expect(SCENE_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(SCENE_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(SCENE_CONTENT_SECURITY_POLICY).not.toContain("https:");
    expect(SCENE_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
  });

  it("escapes data so a payload cannot close the script tag", () => {
    const doc = buildSceneDocument({ html: "<p>x</p>", data: { evil: "</script><img src=x>" } });
    expect(doc).not.toContain("</script><img src=x>");
    expect(doc).toContain("\\u003c/script>");
  });

  it("ships an SDK with no remote dependency", () => {
    const doc = buildSceneDocument({ html: "<p>x</p>" });
    expect(doc).toContain("window.ade");
    expect(doc).toContain("countUp");
    expect(doc).not.toMatch(/<script[^>]+src=/i);
  });
});

describe("parseSceneHostMessage", () => {
  it("accepts only its own tagged, known messages", () => {
    expect(parseSceneHostMessage({ type: "ready", payload: {} })).toBeNull();
    expect(parseSceneHostMessage({ __adeScene: 1, type: "evalThis", payload: {} })).toBeNull();
    expect(parseSceneHostMessage(null)).toBeNull();
    expect(parseSceneHostMessage({ __adeScene: 1, type: "ready", payload: { height: 300 } })).toEqual({
      type: "ready",
      payload: { height: 300 },
    });
  });

  it("clamps a height a scene could otherwise use to blow out the transcript", () => {
    const msg = parseSceneHostMessage({ __adeScene: 1, type: "resize", payload: { height: 99_999 } });
    expect(msg?.payload).toEqual({ height: 4000 });
  });

  it("drops an emit with no name and truncates a long error", () => {
    expect(parseSceneHostMessage({ __adeScene: 1, type: "emit", payload: {} })).toBeNull();
    const err = parseSceneHostMessage({ __adeScene: 1, type: "error", payload: { message: "e".repeat(900) } });
    expect(err?.type).toBe("error");
    expect(err && "message" in err.payload ? err.payload.message.length : 0).toBe(500);
  });
});
