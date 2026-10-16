import { describe, expect, it } from "vitest";
import {
  citedProofArtifactIds,
  parseProofCitationUrl,
  parseProofCompareBlock,
  proofCitationMarkdown,
  proofCompareBlocks,
} from "./proofCitation";

describe("proof citation urls", () => {
  it("reads the artifact id from the forms a provider may write", () => {
    expect(parseProofCitationUrl("ade-proof://artifact-1")).toBe("artifact-1");
    expect(parseProofCitationUrl("ade-proof:artifact-1")).toBe("artifact-1");
    expect(parseProofCitationUrl("ADE-PROOF://artifact_1")).toBe("artifact_1");
  });

  it("rejects a url that is not a citation, is empty, or points at a sub-path", () => {
    expect(parseProofCitationUrl("https://example.com/x.png")).toBeNull();
    expect(parseProofCitationUrl("ade-proof://")).toBeNull();
    expect(parseProofCitationUrl("ade-proof://artifact-1/extra")).toBeNull();
    expect(parseProofCitationUrl("ade-proof://has space")).toBeNull();
    expect(parseProofCitationUrl(null)).toBeNull();
  });

  it("builds the snippet an agent can paste, without breaking the alt text", () => {
    expect(proofCitationMarkdown("artifact-1", "Login works"))
      .toBe("![Login works](ade-proof://artifact-1)");
    expect(proofCitationMarkdown("artifact-1", "a [b]\n caption"))
      .toBe("![a b caption](ade-proof://artifact-1)");
    expect(proofCitationMarkdown("artifact-1")).toBe("![](ade-proof://artifact-1)");
  });
});

describe("proof compare blocks", () => {
  it("reads before, after and caption, and drops a half-written block", () => {
    expect(parseProofCompareBlock("before: aaa The old sidebar\nafter: bbb The new sidebar\ncaption: Now uses the lane color."))
      .toEqual({
        before: { artifactId: "aaa", label: "The old sidebar" },
        after: { artifactId: "bbb", label: "The new sidebar" },
        caption: "Now uses the lane color.",
      });
    expect(parseProofCompareBlock("before: aaa\ncaption: only once")).toBeNull();
    // A label after the id may carry a leading dash or colon.
    expect(parseProofCompareBlock("before: aaa - Old\nafter: bbb : New")?.after.label).toBe("New");
  });

  it("finds every complete fence in a markdown answer", () => {
    const markdown = [
      "```proof-compare",
      "before: aaa",
      "after: bbb",
      "```",
      "text",
      "```proof-compare",
      "before: ccc",
      "after: ddd",
      "```",
    ].join("\n");
    expect(proofCompareBlocks(markdown).map((block) => [block.before.artifactId, block.after.artifactId]))
      .toEqual([["aaa", "bbb"], ["ccc", "ddd"]]);
  });

  it("does not count a comparison written as an example inside a code fence", () => {
    const example = ["```markdown", "```proof-compare", "before: aaa", "after: bbb", "```", "```"].join("\n");
    expect(proofCompareBlocks(example)).toEqual([]);
  });
});

describe("citedProofArtifactIds", () => {
  it("counts citations and both sides of a compare block, without repeats", () => {
    const answer = [
      "![Login](ade-proof://one)",
      "and the same picture again ![Login](ade-proof://one)",
      "```proof-compare",
      "before: two Old",
      "after: three New",
      "caption: side by side",
      "```",
    ].join("\n");
    expect(citedProofArtifactIds(answer)).toEqual(["one", "two", "three"]);
  });

  it("does not count a citation written as an example inside code", () => {
    const fenced = [
      "Write proof like this:",
      "```md",
      "![caption](ade-proof://fenced-example)",
      "```",
      "and inline: `![caption](ade-proof://inline-example)`",
      "```proof-compare",
      "before: real-before",
      "after: real-after",
      "```",
    ].join("\n");
    expect(citedProofArtifactIds(fenced)).toEqual(["real-before", "real-after"]);
  });

  it("ignores an ordinary image and any non-citation link", () => {
    expect(citedProofArtifactIds("![pic](https://example.com/pic.png) [link](ade-proof://not-inline)"))
      .toEqual([]);
  });
});
