import { describe, expect, it } from "vitest";
import {
  buildSceneDocument,
  hasOpenSceneFence,
  isSceneParseFailure,
  parseSceneFence,
  parseSceneHostMessage,
  SCENE_CONTENT_SECURITY_POLICY,
  SCENE_LIMITS,
  SCENE_SETTLE_MAX_MS,
  SCENE_SETTLE_QUIET_MS,
  sceneScopeKeyFor,
  summarizeSceneFence,
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

  /**
   * The strip is document furniture, not anything shaped like it. A scene that
   * renders a snippet of HTML as its own content keeps every byte of it.
   */
  it("never strips wrapper tags out of script or style text", () => {
    const parsed = parseSceneFence([
      "<div id=\"out\"></div>",
      "<script>",
      "  var sample = \"<body> and </body> and <!doctype html>\";",
      "  document.getElementById(\"out\").textContent = sample;",
      "</" + "script>",
      "<style>/* <body> inside a comment */ p { color: red }</style>",
    ].join("\n"));
    if (isSceneParseFailure(parsed)) throw new Error("expected a scene");
    expect(parsed.html).toContain("<body> and </body> and <!doctype html>");
    expect(parsed.html).toContain("/* <body> inside a comment */");
    // ...and the real wrapper outside those regions still goes.
    const wrapped = parseSceneFence("<body><script>var s = \"<body>\";</" + "script></body>");
    if (isSceneParseFailure(wrapped)) throw new Error("expected a scene");
    expect(wrapped.html.startsWith("<script")).toBe(true);
    expect(wrapped.html).toContain("var s = \"<body>\";");
  });

  it("refuses an empty scene and an oversized one", () => {
    const empty = parseSceneFence('<!-- @scene title="x" -->\n   ');
    expect(isSceneParseFailure(empty) && empty.reason).toBe("empty");
    const big = parseSceneFence("x".repeat(SCENE_LIMITS.maxSourceBytes + 1));
    expect(isSceneParseFailure(big) && big.reason).toBe("too-large");
  });
});

describe("SCENE_LIMITS", () => {
  /** The server-side bound has to leave room for the template it wraps. */
  it("allows a full-size source plus the document template", () => {
    expect(SCENE_LIMITS.maxDocumentBytes).toBeGreaterThan(SCENE_LIMITS.maxSourceBytes);
    const document = buildSceneDocument({ html: "x".repeat(SCENE_LIMITS.maxSourceBytes) });
    expect(new TextEncoder().encode(document).length)
      .toBeLessThanOrEqual(SCENE_LIMITS.maxDocumentBytes);
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

  /**
   * The document has to be able to name itself, because the host cannot: one
   * mounted frame shows document after document and its `contentWindow` is the
   * same object throughout, so only a value carried IN the document tells a
   * message from the outgoing view apart from one from the incoming view.
   */
  it("stamps the document with its nonce and echoes it on every message", () => {
    const doc = buildSceneDocument({ html: "<p>x</p>", nonce: "doc-7" });
    expect(doc).toContain('window.__ADE_SCENE_NONCE__ = "doc-7"');
    expect(doc).toContain("message.nonce = String(window.__ADE_SCENE_NONCE__)");
    // A caller that has no nonce still gets a document, just an unstamped one.
    expect(buildSceneDocument({ html: "<p>x</p>" })).toContain("window.__ADE_SCENE_NONCE__ = null");
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

  it("accepts the settled message, so a scene can say when it stopped moving", () => {
    expect(parseSceneHostMessage({ __adeScene: 1, type: "settled", payload: { height: 240 } })).toEqual({
      type: "settled",
      payload: { height: 240 },
    });
    // Same clamp as every other sizing message: the frame is still untrusted.
    const huge = parseSceneHostMessage({ __adeScene: 1, type: "settled", payload: { height: 99_999 } });
    expect(huge?.payload).toEqual({ height: 4000 });
  });

  /**
   * The parser only CARRIES the nonce; deciding whether it is the right one is
   * the host's job, since only the host knows which document is in the frame.
   */
  it("carries a usable nonce through and drops an unusable one", () => {
    expect(parseSceneHostMessage({ __adeScene: 1, type: "settled", nonce: "doc-7", payload: {} }))
      .toEqual({ nonce: "doc-7", type: "settled", payload: { height: undefined } });
    expect(parseSceneHostMessage({ __adeScene: 1, type: "emit", nonce: "doc-7", payload: { name: "go" } }))
      .toMatchObject({ nonce: "doc-7", type: "emit" });
    // Neither a wrong type nor an empty string may look like a real nonce.
    expect(parseSceneHostMessage({ __adeScene: 1, type: "ready", nonce: 7, payload: {} }))
      .not.toHaveProperty("nonce");
    expect(parseSceneHostMessage({ __adeScene: 1, type: "ready", nonce: "", payload: {} }))
      .not.toHaveProperty("nonce");
    expect(parseSceneHostMessage({ __adeScene: 1, type: "ready", payload: {} }))
      .not.toHaveProperty("nonce");
    const long = parseSceneHostMessage({ __adeScene: 1, type: "ready", nonce: "n".repeat(400), payload: {} });
    expect(long?.nonce?.length).toBe(120);
  });

  it("drops an emit with no name and truncates a long error", () => {
    expect(parseSceneHostMessage({ __adeScene: 1, type: "emit", payload: {} })).toBeNull();
    const err = parseSceneHostMessage({ __adeScene: 1, type: "error", payload: { message: "e".repeat(900) } });
    expect(err?.type).toBe("error");
    expect(err && "message" in err.payload ? err.payload.message.length : 0).toBe(500);
  });
});

describe("hasOpenSceneFence", () => {
  it("is true only while the last scene fence is still open", () => {
    expect(hasOpenSceneFence("```scene\n<p>half")).toBe(true);
    expect(hasOpenSceneFence("```scene\n<p>done</p>\n```")).toBe(false);
    expect(hasOpenSceneFence("```ts\nconst a = 1;")).toBe(false);
    // A ``` inside an open ts block closes that block; it does not open a scene.
    expect(hasOpenSceneFence("```ts\nconst a = 1;\n```\n```scene\n<p>")).toBe(true);
    expect(hasOpenSceneFence("no fences here")).toBe(false);
  });
});

describe("summarizeSceneFence", () => {
  it("collapses a scene to one line naming it", () => {
    expect(summarizeSceneFence('<!-- @scene title="Merged PRs" -->\n<p>x</p>'))
      .toBe("[scene: Merged PRs]");
    expect(summarizeSceneFence("<p>x</p>")).toBe("[scene: generated view]");
    expect(summarizeSceneFence("   ")).toBe("[scene: generated view]");
  });
});

describe("the settle watcher in the injected SDK", () => {
  const document_ = buildSceneDocument({ html: "<p>hi</p>" });

  it("posts settled on both signals, with the quiet window and the cap baked in", () => {
    // Animations alone miss a requestAnimationFrame counter; mutations alone
    // miss a transform that never touches the DOM. Both have to be watched or
    // the still is taken mid-animation on half the scenes that have one.
    expect(document_).toContain("getAnimations");
    expect(document_).toContain("MutationObserver");
    expect(document_).toContain(`}, ${SCENE_SETTLE_QUIET_MS});`);
    expect(document_).toContain(`setTimeout(reportSettled, ${SCENE_SETTLE_MAX_MS})`);
  });

  it("keeps the SDK a single template — no stray backtick reopens it", () => {
    // A backtick inside the embedded source is not a style problem: it ends the
    // template literal that carries the whole SDK and takes the file's parse
    // with it.
    expect(document_).not.toContain("`");
  });

  it("caps the wait so a scene that never stops still produces a still", () => {
    expect(SCENE_SETTLE_MAX_MS).toBeGreaterThan(SCENE_SETTLE_QUIET_MS);
  });

  /**
   * Two scene fences in one message used to share the transcript row key, so
   * whichever settled last overwrote the other's still and a reopened chat drew
   * the same picture twice.
   */
  describe("sceneScopeKeyFor", () => {
    it("separates two fences in the same row", () => {
      expect(sceneScopeKeyFor("row-1", "<p>a</p>")).not.toBe(sceneScopeKeyFor("row-1", "<p>b</p>"));
    });

    it("separates the same fence in two rows", () => {
      expect(sceneScopeKeyFor("row-1", "<p>a</p>")).not.toBe(sceneScopeKeyFor("row-2", "<p>a</p>"));
    });

    /** Stored with the still in main, so every later mount must derive it again. */
    it("is stable for the same row and body", () => {
      expect(sceneScopeKeyFor("row-1", "<p>a</p>")).toBe(sceneScopeKeyFor("row-1", "<p>a</p>"));
      expect(sceneScopeKeyFor("row-1", "<p>a</p>").startsWith("row-1:")).toBe(true);
    });
  });
});
