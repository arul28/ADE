import { describe, expect, it } from "vitest";
import { jiraAdfToMarkdown, markdownToJiraAdf } from "./jiraAdf";

describe("Jira ADF conversion", () => {
  it("renders formatted blocks, nested lists, mentions, media, and tables as markdown", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            { type: "text", text: "Read this", marks: [{ type: "strong" }] },
            { type: "text", text: " carefully", marks: [{ type: "em" }] },
          ],
        },
        { type: "paragraph", content: [
          { type: "text", text: "source", marks: [{ type: "link", attrs: { href: "https://example.test/docs" } }] },
          { type: "text", text: " `code`", marks: [{ type: "code" }] },
          { type: "text", text: " gone", marks: [{ type: "strike" }] },
          { type: "mention", attrs: { text: "Morgan Lee" } },
          { type: "hardBreak" },
          { type: "text", text: "next" },
        ] },
        { type: "bulletList", content: [
          { type: "listItem", content: [
            { type: "paragraph", content: [{ type: "text", text: "parent" }] },
            { type: "orderedList", attrs: { order: 2 }, content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }] },
            ] },
          ] },
        ] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const answer = 42;" }] },
        { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
        { type: "rule" },
        { type: "mediaSingle", content: [{ type: "media", attrs: { alt: "diagram.png" } }] },
        { type: "table", content: [
          { type: "tableRow", content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "mode" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "safe | fast" }] }] },
          ] },
        ] },
      ],
    };

    const markdown = jiraAdfToMarkdown(adf);
    expect(markdown).toContain("## **Read this** _carefully_");
    expect(markdown).toContain("[source](https://example.test/docs)");
    expect(markdown).toContain("~~gone~~");
    expect(markdown).toContain("@Morgan Lee");
    expect(markdown).toContain("  \nnext");
    expect(markdown).toContain("- parent\n  2. child");
    expect(markdown).toContain("```ts\nconst answer = 42;\n```");
    expect(markdown).toContain("> quoted");
    expect(markdown).toContain("[media: diagram.png]");
    expect(markdown).toContain("| mode | safe \\| fast |");
  });

  it("converts markdown structure and inline formatting to ADF", () => {
    const adf = markdownToJiraAdf(
      "## Summary\n\nA **bold** and _italic_ `token` with ~~strike~~ and [a link](https://example.test).  \nNext line.\n\n- parent\n  - child\n\n> quoted\n\n```ts\nconst value = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| mode | safe |",
    );

    expect(adf.type).toBe("doc");
    expect(adf.content?.map((node) => node.type)).toEqual([
      "heading", "paragraph", "bulletList", "blockquote", "codeBlock", "table",
    ]);
    const paragraph = adf.content?.[1];
    expect(paragraph?.content?.map((node) => node.type)).toContain("hardBreak");
    expect(paragraph?.content?.find((node) => node.text === "bold")?.marks).toEqual([{ type: "strong" }]);
    const list = adf.content?.[2];
    expect(list?.content?.[0]?.content?.[1]?.type).toBe("bulletList");
    expect(jiraAdfToMarkdown(adf)).toContain("[a link](https://example.test)");
  });
});
