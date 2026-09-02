import { describe, expect, it } from "vitest";

import {
  VOCAB_MARKDOWN_LIMITS,
  clampVocabMarkdownSource,
  parseVocabMarkdown,
  vocabMarkdownPlainText,
  type VocabMarkdownBlock,
  type VocabMarkdownSpan,
} from "./vocabularyMarkdown";
import { parsePluginPanel } from "./vocabulary";
import { VOCAB_LIMITS } from "./vocabularyNodes";

/**
 * The `markdown` node's subset, tested where it is DEFINED.
 *
 * Every TS client calls `parseVocabMarkdown`, so these are the assertions that
 * hold for desktop, the web client and the terminal at once; the per-client
 * suites test only what that client draws. The Swift mirror in
 * `apps/ios/ADETests/PluginVocabularyMarkdownTests.swift` asserts the same
 * documents, case for case, which is the only thing keeping the fourth client
 * honest.
 */

function blocks(source: string): VocabMarkdownBlock[] {
  return parseVocabMarkdown(source).blocks;
}

/** Every span in a document, in reading order. */
function allSpans(list: readonly VocabMarkdownBlock[]): VocabMarkdownSpan[] {
  const out: VocabMarkdownSpan[] = [];
  for (const block of list) {
    if (block.kind === "heading" || block.kind === "paragraph") out.push(...block.spans);
    if (block.kind === "quote") out.push(...allSpans(block.blocks));
    if (block.kind === "list") for (const item of block.items) out.push(...allSpans(item.blocks));
    if (block.kind === "table") {
      for (const cell of block.header) out.push(...cell);
      for (const row of block.rows) for (const cell of row) out.push(...cell);
    }
  }
  return out;
}

function text(list: readonly VocabMarkdownBlock[]): string {
  return vocabMarkdownPlainText(list);
}

describe("parseVocabMarkdown — the security line", () => {
  it("keeps a script tag as literal text and never as a block of its own", () => {
    const parsed = blocks("Hello <script>alert(1)</script> there");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.kind).toBe("paragraph");
    expect(text(parsed)).toBe("Hello <script>alert(1)</script> there");
    // The whole point: there is no field on a span that could carry markup, so
    // the tag can only ever arrive as characters a client escapes.
    for (const span of allSpans(parsed)) {
      expect(Object.keys(span).sort()).toEqual(["text"]);
    }
  });

  it("keeps an img onerror payload as text", () => {
    const parsed = blocks('<img src=x onerror="alert(1)">');
    expect(text(parsed)).toBe('<img src=x onerror="alert(1)">');
    expect(allSpans(parsed).every((span) => span.href === undefined)).toBe(true);
  });

  it("refuses a javascript: link and keeps its words", () => {
    const parsed = blocks("[Click me](javascript:alert(1))");
    expect(text(parsed)).toBe("Click me");
    expect(allSpans(parsed).every((span) => span.href === undefined)).toBe(true);
  });

  it("refuses data:, file: and http: destinations", () => {
    for (const url of ["data:text/html,<b>x", "file:///etc/passwd", "http://example.com"]) {
      const parsed = blocks(`[link](${url})`);
      expect(allSpans(parsed).every((span) => span.href === undefined), url).toBe(true);
      expect(text(parsed), url).toBe("link");
    }
  });

  it("refuses a scheme wearing https, and an https URL with no host", () => {
    for (const url of ["https:javascript:alert(1)", "https://"]) {
      expect(allSpans(blocks(`[x](${url})`)).every((span) => span.href === undefined), url).toBe(true);
    }
  });

  it("keeps an https link, normalized", () => {
    const spans = allSpans(blocks("See [the issue](https://linear.app/ade/issue/ADE-1)."));
    const link = spans.find((span) => span.href !== undefined);
    expect(link?.text).toBe("the issue");
    expect(link?.href).toBe("https://linear.app/ade/issue/ADE-1");
    // The prose around it is not swallowed by the link.
    expect(text(blocks("See [the issue](https://linear.app/x)."))).toBe("See the issue.");
  });

  it("takes an https autolink and refuses every other scheme in the same form", () => {
    expect(allSpans(blocks("<https://ade.dev>"))[0]?.href).toBe("https://ade.dev/");
    expect(allSpans(blocks("<javascript:alert(1)>")).every((s) => s.href === undefined)).toBe(true);
    // Not a URL at all: an HTML-looking fragment stays text.
    expect(text(blocks("<b>bold</b>"))).toBe("<b>bold</b>");
  });

  it("does not autolink a bare URL — three clients would disagree about where it ends", () => {
    const spans = allSpans(blocks("Go to https://ade.dev/x, then stop."));
    expect(spans.every((span) => span.href === undefined)).toBe(true);
  });

  it("refuses a link inside a link rather than nesting destinations", () => {
    const spans = allSpans(blocks("[outer [inner](https://evil.test)](https://ok.test)"));
    const hrefs = new Set(spans.flatMap((span) => (span.href ? [span.href] : [])));
    expect(hrefs).toEqual(new Set(["https://ok.test/"]));
  });

  it("refuses a link longer than the ceiling the openUrl verb uses", () => {
    const long = `https://ade.dev/${"a".repeat(VOCAB_MARKDOWN_LIMITS.maxMarkdownHrefChars)}`;
    expect(allSpans(blocks(`[x](${long})`)).every((span) => span.href === undefined)).toBe(true);
  });
});

describe("parseVocabMarkdown — the subset", () => {
  it("reads all six heading levels and stops at six", () => {
    expect(blocks("# a\n\n## b\n\n###### f").map((block) => block.kind === "heading" && block.level))
      .toEqual([1, 2, 6]);
    // Seven hashes is not a heading; it is a paragraph that starts with hashes.
    expect(blocks("####### g")[0]?.kind).toBe("paragraph");
  });

  it("reads bold, italic and strikethrough, including nested emphasis as flags", () => {
    const spans = allSpans(blocks("**bold** _italic_ ~~gone~~ **b _and i_**"));
    expect(spans.find((span) => span.text === "bold")?.bold).toBe(true);
    expect(spans.find((span) => span.text === "italic")?.italic).toBe(true);
    expect(spans.find((span) => span.text === "gone")?.strike).toBe(true);
    const both = spans.find((span) => span.text === "and i");
    expect([both?.bold, both?.italic]).toEqual([true, true]);
  });

  it("leaves snake_case alone and an unclosed delimiter literal", () => {
    expect(allSpans(blocks("read plugin_panel_row now")).every((s) => s.italic === undefined)).toBe(true);
    expect(text(blocks("2 * 3 and **unclosed"))).toBe("2 * 3 and **unclosed");
  });

  it("reads an inline code span and lets nothing inside it be markup", () => {
    const spans = allSpans(blocks("Run `**not bold** <b>` now"));
    const code = spans.find((span) => span.code === true);
    expect(code?.text).toBe("**not bold** <b>");
    expect([code?.bold, code?.href]).toEqual([undefined, undefined]);
  });

  it("reads a fenced block with its language, and an unclosed fence to the end", () => {
    const fenced = blocks("```ts\nconst a = 1;\n```")[0];
    expect(fenced).toEqual({ kind: "code", language: "ts", text: "const a = 1;" });
    expect(blocks("```\nstill code\n")[0]).toEqual({ kind: "code", text: "still code" });
    // A fence's content is never markdown: hashes inside it stay hashes.
    expect(blocks("```\n# not a heading\n```")[0]).toEqual({ kind: "code", text: "# not a heading" });
  });

  it("reads bullet and ordered lists, and keeps an ordered list's start", () => {
    const bullets = blocks("- one\n- two")[0];
    expect(bullets?.kind === "list" && [bullets.ordered, bullets.items.length]).toEqual([false, 2]);
    const ordered = blocks("3. three\n4. four")[0];
    expect(ordered?.kind === "list" && [ordered.ordered, ordered.start]).toEqual([true, 3]);
  });

  it("reads a task list and renders it as data only — there is nothing to press", () => {
    const list = blocks("- [x] done\n- [ ] not done\n- plain")[0];
    if (list?.kind !== "list") throw new Error("expected a list");
    expect(list.items.map((item) => item.task)).toEqual(["checked", "unchecked", undefined]);
    // The checkbox marker is consumed, so no client draws it twice.
    expect(text([list])).toBe("done\nnot done\nplain");
    // Inert by construction: an item carries blocks and a task state, and the
    // type has no slot an action could arrive in.
    expect(Object.keys(list.items[0]!).sort()).toEqual(["blocks", "task"]);
  });

  it("reads a blockquote and re-parses its content as blocks", () => {
    const quote = blocks("> ## quoted\n> and **prose**")[0];
    if (quote?.kind !== "quote") throw new Error("expected a quote");
    expect(quote.blocks.map((block) => block.kind)).toEqual(["heading", "paragraph"]);
  });

  it("reads a thematic break and does not read a setext heading", () => {
    expect(blocks("a\n\n---\n\nb").map((block) => block.kind))
      .toEqual(["paragraph", "rule", "paragraph"]);
    expect(blocks("Title\n===").map((block) => block.kind)).toEqual(["paragraph"]);
  });

  it("admits an https image and keeps its alt", () => {
    const parsed = blocks("Before ![a diagram](https://ade.dev/x.png) after");
    expect(text(parsed)).toBe("Before a diagram after");
    const image = allSpans(parsed).find((span) => span.src !== undefined);
    expect(image?.src).toBe("https://ade.dev/x.png");
    expect(image?.href).toBeUndefined();
  });

  it("refuses a data: image and keeps its alt as prose", () => {
    const parsed = blocks("![secret](data:image/png;base64,abcd)");
    expect(text(parsed)).toBe("secret");
    expect(allSpans(parsed).every((span) => span.src === undefined)).toBe(true);
  });

  it("reads a GFM pipe table with alignment", () => {
    const parsed = blocks([
      "| Name | State |",
      "| :--- | ---: |",
      "| ISS-1 | Open |",
      "| ISS-2 | **Done** |",
    ].join("\n"));
    expect(parsed.map((block) => block.kind)).toEqual(["table"]);
    const table = parsed[0];
    if (table?.kind !== "table") throw new Error("expected a table");
    expect(table.align).toEqual(["left", "right"]);
    expect(text([table])).toBe("Name | State\nISS-1 | Open\nISS-2 | Done");
    expect(allSpans([table]).find((span) => span.text === "Done")?.bold).toBe(true);
  });

  it("ends a paragraph where a table begins", () => {
    expect(blocks("intro\n| a | b |\n| --- | --- |\n| 1 | 2 |").map((block) => block.kind))
      .toEqual(["paragraph", "table"]);
  });

  it("drops extra table columns and extra table rows rather than exploding", () => {
    const header = Array.from({ length: 12 }, (_u, i) => `h${i}`).join(" | ");
    const delim = Array.from({ length: 12 }, () => "---").join(" | ");
    const extraRows = Array.from(
      { length: VOCAB_MARKDOWN_LIMITS.maxMarkdownTableRows + 5 },
      (_u, i) => `r${i} | x`,
    );
    const parsed = parseVocabMarkdown(`| ${header} |\n| ${delim} |\n${extraRows.map((row) => `| ${row} |`).join("\n")}`);
    const table = parsed.blocks[0];
    if (table?.kind !== "table") throw new Error("expected a table");
    expect(table.header).toHaveLength(VOCAB_MARKDOWN_LIMITS.maxMarkdownTableColumns);
    expect(table.rows.length).toBe(VOCAB_MARKDOWN_LIMITS.maxMarkdownTableRows);
    expect(parsed.truncated).toBe(true);
  });

  it("keeps line breaks inside a paragraph and separates blocks on a blank line", () => {
    expect(blocks("one\ntwo").map((block) => block.kind)).toEqual(["paragraph"]);
    expect(text(blocks("one\ntwo"))).toBe("one\ntwo");
    expect(blocks("one\n\ntwo")).toHaveLength(2);
  });

  it("ends a paragraph where the next block begins", () => {
    expect(blocks("intro\n- one\n- two").map((block) => block.kind)).toEqual(["paragraph", "list"]);
    expect(blocks("intro\n# head").map((block) => block.kind)).toEqual(["paragraph", "heading"]);
  });

  it("reads a document written on Windows", () => {
    expect(blocks("# a\r\n\r\n- one\r\n- two").map((block) => block.kind)).toEqual(["heading", "list"]);
  });

  it("honours a backslash escape", () => {
    expect(text(blocks("\\*not italic\\*"))).toBe("*not italic*");
    expect(allSpans(blocks("\\*not italic\\*")).every((span) => span.italic === undefined)).toBe(true);
  });
});

describe("parseVocabMarkdown — the ceilings", () => {
  it("stops at the block budget and says it stopped", () => {
    const parsed = parseVocabMarkdown(
      Array.from({ length: VOCAB_MARKDOWN_LIMITS.maxMarkdownBlocks + 20 }, (_u, i) => `p${i}`)
        .join("\n\n"),
    );
    expect(parsed.blocks.length).toBeLessThanOrEqual(VOCAB_MARKDOWN_LIMITS.maxMarkdownBlocks);
    expect(parsed.truncated).toBe(true);
  });

  it("does not report truncation for a document that fits", () => {
    expect(parseVocabMarkdown("# a\n\nb").truncated).toBe(false);
  });

  it("stops nesting containers at the depth ceiling and keeps the marker as text", () => {
    const parsed = blocks("> > > > deep");
    const flat = text(parsed);
    expect(flat).toContain(">");
    // The document still renders; only the extra containers are gone.
    expect(flat).toContain("deep");
  });

  it("folds a pathological run of delimiters into a bounded span list", () => {
    const parsed = blocks("*a*".repeat(400));
    for (const block of parsed) {
      if (block.kind === "paragraph") {
        expect(block.spans.length).toBeLessThanOrEqual(VOCAB_MARKDOWN_LIMITS.maxMarkdownSpans);
      }
    }
    // Nothing is deleted — the text past the ceiling is one plain run.
    expect(text(parsed).replace(/\*/g, "")).toBe("a".repeat(400));
  });
});

describe("the markdown node", () => {
  function node(raw: Record<string, unknown>) {
    const parsed = parsePluginPanel({
      v: 1,
      fallback: { title: "t", text: "f" },
      body: [{ component: "markdown", ...raw }],
    });
    if (!parsed.ok) throw new Error("panel did not parse");
    return parsed.panel.body[0]!;
  }

  it("parses a document and carries no truncation flag", () => {
    expect(node({ text: "# Title\n\nBody" })).toEqual({
      component: "markdown",
      text: "# Title\n\nBody",
    });
  });

  it("degrades to an invalid node when `text` is missing or empty", () => {
    expect(node({}).component).toBe("__invalid");
    expect(node({ text: "   " }).component).toBe("__invalid");
  });

  it("clamps an over-long document and flags it rather than appending an ellipsis", () => {
    const parsed = node({ text: "a".repeat(VOCAB_LIMITS.maxMarkdownChars + 500) });
    if (parsed.component !== "markdown") throw new Error("expected a markdown node");
    expect(parsed.text).toHaveLength(VOCAB_LIMITS.maxMarkdownChars);
    expect(parsed.truncated).toBe(true);
    // No ellipsis inside the source: it would render as content, and a cut that
    // landed in a fence would draw it as code.
    expect(parsed.text.endsWith("…")).toBe(false);
  });

  it("cuts an over-long document at the last complete line, not mid-fence", () => {
    const source = `# Title\n\n\`\`\`ts\n${"const x = 1;\n".repeat(2_000)}`;
    const clamped = clampVocabMarkdownSource(source);
    expect(clamped.truncated).toBe(true);
    expect(clamped.text.endsWith("\n")).toBe(false);
    expect(clamped.text.includes("# Title")).toBe(true);
    // The window still parses as markdown rather than as a source dump.
    const parsed = parseVocabMarkdown(clamped.text);
    expect(parsed.blocks[0]?.kind).toBe("heading");
  });

  it("is a known component, so no client reports it as unknown", () => {
    expect(VOCAB_LIMITS.maxMarkdownChars).toBe(16_000);
    expect(VOCAB_LIMITS.maxMarkdownChars).toBeGreaterThan(VOCAB_LIMITS.maxTextChars);
    expect(VOCAB_LIMITS.maxListItemMarkdownChars).toBe(VOCAB_LIMITS.maxTextChars);
    expect(node({ text: "x" }).component).toBe("markdown");
  });
});

describe("a golden issue body", () => {
  /** The shape D10/D12 actually ship: a Linear description with a comment. */
  const GOLDEN = [
    "## Fix the login redirect",
    "",
    "The redirect drops the `next` param when the session is **stale**.",
    "See [ADE-122](https://linear.app/ade/issue/ADE-122) for the trace.",
    "",
    "- [x] Reproduce on `main`",
    "- [ ] Add a regression test",
    "",
    "> Reviewer: this is ~~blocked~~ ready.",
    "",
    "```ts",
    "const next = url.searchParams.get(\"next\");",
    "```",
    "",
    "---",
    "",
    "<script>alert(1)</script>",
  ].join("\n");

  it("reads every feature of the subset out of one document", () => {
    const parsed = parseVocabMarkdown(GOLDEN);
    expect(parsed.truncated).toBe(false);
    expect(parsed.blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "quote",
      "code",
      "rule",
      "paragraph",
    ]);

    const spans = allSpans(parsed.blocks);
    expect(spans.find((span) => span.text === "next")?.code).toBe(true);
    expect(spans.find((span) => span.text === "stale")?.bold).toBe(true);
    expect(spans.find((span) => span.text === "blocked")?.strike).toBe(true);
    expect(spans.find((span) => span.text === "ADE-122")?.href)
      .toBe("https://linear.app/ade/issue/ADE-122");

    const list = parsed.blocks[2];
    expect(list?.kind === "list" && list.items.map((item) => item.task))
      .toEqual(["checked", "unchecked"]);

    expect(parsed.blocks[4]).toEqual({
      kind: "code",
      language: "ts",
      text: 'const next = url.searchParams.get("next");',
    });

    // The tag is the last paragraph's text, not a tag.
    expect(text([parsed.blocks[6]!])).toBe("<script>alert(1)</script>");
  });
});
