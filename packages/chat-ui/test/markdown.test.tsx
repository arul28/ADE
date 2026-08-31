import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdownBlocks, renderMarkdown, safeHref } from "../src/transcript/markdown";

describe("parseMarkdownBlocks", () => {
  it("splits paragraphs, headings, lists and rules", () => {
    const blocks = parseMarkdownBlocks("# Title\n\nBody text\n\n- one\n- two\n\n---");
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "rule",
    ]);
  });

  it("keeps fenced code verbatim, including markdown-looking lines", () => {
    const blocks = parseMarkdownBlocks("```js\n# not a heading\n- not a list\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "code",
      language: "js",
      text: "# not a heading\n- not a list",
    });
  });

  it("renders an unterminated fence as code, because streaming text is partial", () => {
    const blocks = parseMarkdownBlocks("```\nhalf a block");
    expect(blocks[0]).toMatchObject({ kind: "code", text: "half a block" });
  });

  it("distinguishes ordered from unordered lists", () => {
    expect(parseMarkdownBlocks("1. one\n2. two")[0]).toMatchObject({
      kind: "list",
      ordered: true,
      items: ["one", "two"],
    });
    expect(parseMarkdownBlocks("* one")[0]).toMatchObject({ kind: "list", ordered: false });
  });
});

describe("parseInline", () => {
  it("recognises code, bold, italic and links", () => {
    expect(parseInline("a `b` **c** *d* [e](https://x.test)").map((token) => token.kind)).toEqual([
      "text",
      "code",
      "text",
      "strong",
      "text",
      "em",
      "text",
      "link",
    ]);
  });

  it("autolinks bare URLs", () => {
    expect(parseInline("see https://x.test now")[1]).toMatchObject({
      kind: "link",
      href: "https://x.test",
    });
  });
});

describe("safeHref", () => {
  it("rejects script-bearing schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
  });

  it("rejects protocol-relative hrefs that would escape the host's origin", () => {
    // `//evil.example/x` looks like a site-root path but loads another origin.
    expect(safeHref("//evil.example/x")).toBeNull();
    // Browsers normalise backslashes in the authority position, so these three
    // resolve exactly like `//evil.example/x`.
    expect(safeHref("\\\\evil.example/x")).toBeNull();
    expect(safeHref("/\\evil.example/x")).toBeNull();
    expect(safeHref("\\/evil.example/x")).toBeNull();
    // Leading whitespace must not smuggle one past the check.
    expect(safeHref("  //evil.example/x")).toBeNull();
  });

  it("allows the schemes a chat link plausibly uses", () => {
    expect(safeHref("https://x.test")).toBe("https://x.test");
    expect(safeHref("http://x.test")).toBe("http://x.test");
    expect(safeHref("mailto:a@b.test")).toBe("mailto:a@b.test");
    expect(safeHref("#anchor")).toBe("#anchor");
    expect(safeHref("./rel")).toBe("./rel");
    expect(safeHref("/relative")).toBe("/relative");
    // A single-segment root path is still a same-origin path, not an authority.
    expect(safeHref("/relative//deep")).toBe("/relative//deep");
  });

  it("drops a protocol-relative link's href but keeps its text", () => {
    const { container } = render(
      <div>{renderMarkdown("[click](//evil.example/x)")}</div>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("click");
  });
});

describe("renderMarkdown", () => {
  it("renders raw HTML in a model response as text, never as markup", () => {
    const { container } = render(<div>{renderMarkdown("<img src=x onerror=alert(1)>")}</div>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("drops the href of an unsafe link but keeps its text", () => {
    const { container } = render(
      <div>{renderMarkdown("[click](javascript:alert(1))")}</div>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("click");
  });

  it("opens external links safely", () => {
    const { container } = render(<div>{renderMarkdown("[x](https://x.test)")}</div>);
    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("rel")).toContain("noopener");
    expect(anchor.getAttribute("target")).toBe("_blank");
  });
});
