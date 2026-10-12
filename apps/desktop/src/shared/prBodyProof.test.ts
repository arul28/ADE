import { describe, expect, it } from "vitest";

import {
  PR_ATTACHMENT_TITLE,
  parsePrCompareFence,
  prBodyProofIds,
  prProofIdFromTitle,
  preparePrBodyProofForAde,
  rewritePrBodyProofForGithub,
  type PrCompareFigure,
} from "./prBodyProof";

const BODY = [
  "## What changed",
  "",
  "```proof-compare",
  "before: old1 The old overview",
  "after: new1 The new overview",
  "caption: The strip is on top.",
  "```",
  "",
  "An example in code stays code: `![x](ade-proof://inline1)`.",
  "",
  "![The hint lines](ade-proof://pic1)",
  "",
  "```bash",
  "![x](ade-proof://fenced1)",
  "```",
].join("\n");

/** What `gh --attach` does to the text: each `./file` becomes the uploaded URL. */
function asUploaded(markdown: string): string {
  return markdown.replace(/\]\(\.\/(proof-[\w-]+)\.\w+\)/g, "](https://github.com/user-attachments/assets/$1)");
}

/** The figures ADE will draw for a text, in order. */
function figures(markdown: string): PrCompareFigure[] {
  return [...markdown.matchAll(/```pr-compare\n([\s\S]*?)\n```/g)].map((match) => {
    const figure = parsePrCompareFence(match[1]!);
    expect(figure, "a pr-compare fence ADE can read").not.toBeNull();
    return figure!;
  });
}

const staged = (id: string) => ({ file: `proof-${id}.${id.startsWith("vid") ? "mp4" : "png"}`, video: id.startsWith("vid") });

describe("proof in a pull request's text", () => {
  it("lists the cited proof once each, in reading order, and never a citation that is code", () => {
    expect(prBodyProofIds(`${BODY}\n\n![again](ade-proof://pic1)`)).toEqual(["old1", "new1", "pic1"]);
    expect(prBodyProofIds(null)).toEqual([]);
  });

  it("writes text GitHub can show, and reads the same text back as the proof it is", () => {
    const github = rewritePrBodyProofForGithub(BODY, staged);
    // GitHub shows a pair as a table, with the caption as a sentence under it.
    expect(github).toContain("| Before | After |");
    expect(github).toContain("The strip is on top.");
    expect(github).not.toContain("```proof-compare");
    // Code is left exactly as the author wrote it.
    expect(github).toContain("`![x](ade-proof://inline1)`");
    expect(github).toContain("```bash\n![x](ade-proof://fenced1)\n```");

    const ade = preparePrBodyProofForAde(asUploaded(github));
    expect(figures(ade)).toEqual([{
      sides: [
        { title: "Before", url: "https://github.com/user-attachments/assets/proof-old1", artifactId: "old1", label: "The old overview" },
        { title: "After", url: "https://github.com/user-attachments/assets/proof-new1", artifactId: "new1", label: "The new overview" },
      ],
      caption: null,
    }]);
    // A single picture keeps its proof id, so this machine can show its own copy.
    const picture = /!\[The hint lines\]\((\S+) "([^"]+)"\)/.exec(ade);
    expect(picture?.[1]).toBe("https://github.com/user-attachments/assets/proof-pic1");
    expect(prProofIdFromTitle(picture?.[2])).toBe("pic1");
  });

  it("keeps a comparison whole: two videos stack, and a pair with a side that cannot go up stays as written", () => {
    const videos = "```proof-compare\nbefore: vid1 Slow\nafter: vid2 Fast\n```";
    const github = rewritePrBodyProofForGithub(videos, staged);
    // GitHub plays a video only on its own line, so there is no table.
    expect(github).not.toContain("| Before | After |");
    expect(figures(preparePrBodyProofForAde(asUploaded(github)))[0]!.sides.map((side) => [side.title, side.artifactId, side.label])).toEqual([
      ["Before", "vid1", "Slow"],
      ["After", "vid2", "Fast"],
    ]);

    const half = rewritePrBodyProofForGithub(BODY, (id) => (id === "new1" ? null : staged(id)));
    expect(half).toContain("```proof-compare\nbefore: old1 The old overview");
    expect(half).not.toContain("proof-old1");
    expect(half).toContain("![The hint lines](./proof-pic1.png)");
  });

  it("still shows proof that was never uploaded, and draws a Before and After table that anyone wrote", () => {
    const local = figures(preparePrBodyProofForAde(BODY));
    expect(local[0]!.sides.map((side) => [side.artifactId, side.url])).toEqual([["old1", null], ["new1", null]]);
    expect(local[0]!.caption).toBe("The strip is on top.");

    const foreign = "| Before | After (default) |\n| --- | --- |\n| ![a](https://example.com/a.png) | ![b](https://example.com/b.png) |";
    expect(figures(preparePrBodyProofForAde(foreign))[0]!.sides).toEqual([
      { title: "Before", url: "https://example.com/a.png", artifactId: null, label: "a" },
      { title: "After (default)", url: "https://example.com/b.png", artifactId: null, label: "b" },
    ]);

    // A table of data that happens to mention "before" is not a comparison.
    const data = "| Before | After |\n| --- | --- |\n| 137 ms | 47 ms |";
    expect(preparePrBodyProofForAde(data)).toBe(data);
  });

  it("draws a GitHub attachment alone on its line as media, as GitHub does, and leaves one in a sentence or in code alone", () => {
    const url = "https://github.com/user-attachments/assets/83908590-2459-482d-bce8-9fbe8c7b7974";
    const text = `## Proof\n\n${url}\n\nSee ${url} for the run.\n\n\`\`\`\n${url}\n\`\`\``;
    const ade = preparePrBodyProofForAde(text);
    expect(ade).toContain(`\n![](${url} "${PR_ATTACHMENT_TITLE}")\n`);
    expect(ade).toContain(`See ${url} for the run.`);
    expect(ade).toContain(`\`\`\`\n${url}\n\`\`\``);
    // A link that only looks like an attachment is a link.
    const other = "https://github.com/user-attachments/files/123/report.zip";
    expect(preparePrBodyProofForAde(other)).toBe(other);

    // An uploaded video pair comes back from GitHub as bare links with their proof ids.
    const pair = `**Before** — Slow\n\n${url}<!-- ade-proof:vid1 -->\n\n**After** — Fast\n\n${url}<!-- ade-proof:vid2 -->`;
    expect(figures(preparePrBodyProofForAde(pair))[0]!.sides.map((side) => [side.artifactId, side.url, side.label])).toEqual([
      ["vid1", url, "Slow"],
      ["vid2", url, "Fast"],
    ]);
  });

  it("accepts only an https picture and a well-formed proof id from a fence that any commenter can write", () => {
    const figure = parsePrCompareFence(JSON.stringify({
      sides: [
        { title: "Before", url: "file:///etc/passwd", artifactId: "../../secrets", label: "x" },
        { title: "After", url: "https://example.com/b.png", artifactId: "ok-1", label: null },
      ],
      caption: 7,
    }));
    expect(figure!.sides.map((side) => [side.url, side.artifactId])).toEqual([[null, null], ["https://example.com/b.png", "ok-1"]]);
    expect(figure!.caption).toBeNull();
    expect(parsePrCompareFence("{not json")).toBeNull();
    expect(parsePrCompareFence(JSON.stringify({ sides: [{ title: "Before" }] }))).toBeNull();
    expect(prProofIdFromTitle("ade-proof:../x")).toBeNull();
    expect(prProofIdFromTitle("A normal image title")).toBeNull();
  });
});
