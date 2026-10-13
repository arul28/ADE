import { describe, expect, it } from "vitest";
import {
  cleanClaudePluginUiText,
  isClaudePluginUiOnlyMetaEvent,
  safeClaudePluginUiHref,
  sanitizeClaudePluginUiTree,
  type ClaudePluginUiElement,
} from "./claudePluginUi";

function texts(node: ClaudePluginUiElement | string | null): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(texts).join("");
}

describe("sanitizeClaudePluginUiTree", () => {
  it("keeps what a client may draw and drops the rest of a mod's tree", () => {
    const { tree, targets } = sanitizeClaudePluginUiTree({
      type: "Box",
      props: { flexDirection: "column", width: 40, style: "position:fixed", onClick: "alert(1)" },
      children: [
        { type: "Text", props: { color: "red", bold: true, dangerouslySetInnerHTML: { __html: "<b>x</b>" } }, children: ["hi ", 7] },
        { type: "b", children: ["strong"] },
        { type: "Button", props: { key: "go", label: "Go" }, press: { plugin: "demo", handle: 11 } },
        { type: "Button", props: { label: "No target" }, press: { plugin: "demo", handle: "11" } },
        { type: "Text", children: ["text"], press: { plugin: "demo", handle: 12 } },
        { type: "Select", props: { value: "a", options: ["a", { value: "b", label: "Bee" }, { label: "no value" }] }, press: { plugin: "demo", handle: 13 } },
        { type: "Svg", props: { source: "<svg onload=alert(1)>", alt: "a chart" } },
        { type: "Client", props: { module: "./evil.js" } },
        { type: "constructor", children: ["proto"] },
      ],
    });

    expect(tree?.props).toEqual({ flexDirection: "column", width: 40 });
    const [text, bold, button, untargeted, plainText, select, svgAlt, ...rest] = tree?.children ?? [];
    expect(text).toEqual({ type: "Text", props: { color: "red", bold: true }, children: ["hi ", "7"] });
    expect(bold).toEqual({ type: "Text", props: { bold: true }, children: ["strong"] });
    expect(button).toEqual({ type: "Button", props: { key: "go", label: "Go" }, target: { plugin: "demo", handle: 11 } });
    expect(untargeted).toEqual({ type: "Button", props: { label: "No target" } });
    expect(plainText).toEqual({ type: "Text", props: {}, children: ["text"] });
    expect(select).toMatchObject({
      props: { value: "a", options: [{ value: "a", label: "a" }, { value: "b", label: "Bee" }] },
      target: { plugin: "demo", handle: 13 },
    });
    // An element this surface does not draw leaves only the stand-in text the mod gave.
    expect(svgAlt).toBe("a chart");
    expect(rest).toEqual([]);
    // Only controls a person can act on are targets an action may name.
    expect(targets).toEqual([{ plugin: "demo", handle: 11 }, { plugin: "demo", handle: 13 }]);
  });

  it("bounds a tree a mod made too large or too deep", () => {
    const wide = sanitizeClaudePluginUiTree({
      type: "Box",
      children: Array.from({ length: 3_000 }, (_, index) => ({ type: "Text", children: [`row ${index}`] })),
    });
    expect(wide.tree?.children?.length).toBeLessThan(1_500);
    expect(wide.tree?.children?.length).toBeGreaterThan(1_000);

    const long = sanitizeClaudePluginUiTree({ type: "Text", children: ["x".repeat(200_000)] });
    expect(texts(long.tree).length).toBeLessThanOrEqual(40_001);
    expect(texts(long.tree).length).toBeGreaterThan(30_000);

    let deep: unknown = { type: "Text", children: ["bottom"] };
    for (let level = 0; level < 80; level += 1) deep = { type: "Box", children: [deep] };
    const cut = sanitizeClaudePluginUiTree(deep);
    expect(cut.tree?.type).toBe("Box");
    expect(JSON.stringify(cut.tree)).not.toContain("bottom");

    expect(sanitizeClaudePluginUiTree("just text").tree).toBeNull();
    expect(sanitizeClaudePluginUiTree(null)).toEqual({ tree: null, targets: [] });
  });
});

describe("safeClaudePluginUiHref", () => {
  it.each([
    ["https://example.com/docs?a=1#top", "https://example.com/docs?a=1#top"],
    ["https://example.com", "https://example.com/"],
    ["http://localhost:3000/app", "http://localhost:3000/app"],
  ])("opens %s", (href, expected) => {
    expect(safeClaudePluginUiHref(href)).toBe(expected);
  });

  it.each([
    ["a script", "javascript:alert(1)"],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["a file", "file:///etc/passwd"],
    ["an ADE deeplink", "ade://lane/abc"],
    ["plain http to another host", "http://example.com/"],
    ["a host that only looks local", "http://localhost.example.com/"],
    ["credentials before the host", "https://user:pass@example.com/"],
    ["an at sign in the path", "https://example.com/@user"],
    ["a spelling the browser would rewrite", "https://EXAMPLE.com/"],
    ["a default port", "https://example.com:443/"],
    ["an address over 2,048 characters", `https://example.com/${"a".repeat(2_100)}`],
    ["a relative path", "/settings"],
    ["a number", 42],
  ])("draws %s as plain text", (_name, href) => {
    expect(safeClaudePluginUiHref(href)).toBeNull();
  });
});

describe("mod text and events", () => {
  it("removes control characters and direction overrides from mod text, and cuts it", () => {
    expect(cleanClaudePluginUiText("ok\u0000\u001b[31m‮evil⁦\tkept\nline")).toBe("ok[31mevil\tkept\nline");
    expect(cleanClaudePluginUiText("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
    expect(cleanClaudePluginUiText(undefined)).toBe("");
    expect(cleanClaudePluginUiText({ toString: () => "object" })).toBe("");
  });

  it.each([
    [{ type: "session_meta_updated", claudePluginUi: {} }, true],
    [{ type: "session_meta_updated", claudePluginUi: {}, title: "Renamed" }, false],
    [{ type: "session_meta_updated", title: "Renamed" }, false],
    [{ type: "status", claudePluginUi: {} }, false],
  ])("tells a mod-UI-only event from chat activity: %j", (event, expected) => {
    expect(isClaudePluginUiOnlyMetaEvent(event)).toBe(expected);
  });
});
