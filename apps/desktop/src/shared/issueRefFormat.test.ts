import { describe, expect, it } from "vitest";
import type { IssueRef } from "./issueRef";
import {
  CORE_ISSUE_PLUGIN_ID,
  ISSUE_PROVIDER_GITHUB,
  ISSUE_PROVIDER_LINEAR,
  issueRefFromGitHubIssue,
} from "./issueRef";
import { linearIssueBranchName, linearIssueLaneName } from "./linearIssueBranch";
import { renderLinearPrIssueLinkSection } from "./linearMagicWords";
import { issueRefToLinearIssue } from "./issueRef";
import {
  dedupeIssueRefs,
  ensureIssueRefPrLinkSections,
  ensureIssueRefPrReferences,
  issueProviderLabel,
  issueRefBranchName,
  issueRefLaneName,
  issueRefPrMagicWord,
  issueRefPrReference,
  issueRefSupportsCloseOnMerge,
  issueRefUsesGenericLinkSection,
  renderIssueRefPrLinkSection,
} from "./issueRefFormat";

function ref(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    pluginId: CORE_ISSUE_PLUGIN_ID,
    provider: ISSUE_PROVIDER_LINEAR,
    issueId: "issue-1",
    key: "ADE-123",
    title: "Link Linear issues deeply",
    url: "https://linear.app/ade/issue/ADE-123",
    ...overrides,
  };
}

/**
 * Identifier/title pairs a real Linear workspace can produce. The generic
 * namer must agree with `linearIssueBranchName` on every one of them.
 */
const LINEAR_CORPUS: Array<{ identifier: string; title: string }> = [
  { identifier: "ADE-123", title: "Link Linear issues deeply" },
  { identifier: "ADE-1", title: "a" },
  { identifier: "OPS9-4200", title: "Update ops hooks" },
  { identifier: "X2-7", title: "  leading and trailing space  " },
  { identifier: "ADE-5", title: "Punctuation: colons, commas & (parens)!" },
  { identifier: "ADE-6", title: "slashes/in/the/title and back\\slashes" },
  { identifier: "ADE-7", title: "tilde~caret^question?star*[brackets]" },
  { identifier: "ADE-8", title: "double..dots and trailing dots..." },
  { identifier: "ADE-9", title: "refs/heads/looks-like-a-ref" },
  { identifier: "ADE-10", title: "origin/looks-like-a-remote" },
  { identifier: "ADE-11", title: "ends in .lock" },
  { identifier: "ADE-12", title: "reflog@{selector} syntax" },
  { identifier: "ADE-13", title: "---dashes--everywhere---" },
  { identifier: "ADE-14", title: "émoji 🚀 and ünicode" },
  { identifier: "ADE-15", title: "" },
  { identifier: "ADE-16", title: "   " },
  { identifier: "", title: "no identifier at all" },
  { identifier: "", title: "" },
  { identifier: "  ADE-17  ", title: "untrimmed identifier" },
  { identifier: "lowercase-18", title: "already lowercase key" },
];

describe("issueRefFormat naming", () => {
  it("produces byte-identical branch names to linearIssueBranchName for Linear refs", () => {
    for (const issue of LINEAR_CORPUS) {
      const generic = issueRefBranchName(
        ref({ key: issue.identifier, title: issue.title, provider: ISSUE_PROVIDER_LINEAR }),
      );
      expect(generic, `identifier=${JSON.stringify(issue.identifier)} title=${JSON.stringify(issue.title)}`)
        .toBe(linearIssueBranchName(issue));
    }
  });

  it("produces byte-identical lane names to linearIssueLaneName for Linear refs", () => {
    for (const issue of LINEAR_CORPUS) {
      expect(issueRefLaneName(ref({ key: issue.identifier, title: issue.title })))
        .toBe(linearIssueLaneName(issue));
    }
  });

  it("flattens a GitHub key into a branch that cannot carve out a ref namespace", () => {
    const github = ref({
      provider: ISSUE_PROVIDER_GITHUB,
      key: "ade/app#42",
      title: "Fix the thing",
    });
    expect(issueRefBranchName(github)).toBe("ade-app-42-fix-the-thing");
    expect(issueRefLaneName(github)).toBe("ade/app#42 Fix the thing");
  });

  it("keeps a GitHub-derived ref's branch free of separators and shell metacharacters", () => {
    const branch = issueRefBranchName(issueRefFromGitHubIssue({
      id: "gh-1",
      number: 42,
      owner: "ade",
      repo: "app",
      title: "Windows path C:\\Users\\me and a #hash",
      url: "https://github.com/ade/app/issues/42",
      state: "open",
      labels: [],
      assignees: [],
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:00:00.000Z",
    }));
    // No `/`, no `\`, no `#`, no drive-letter colon: the same ref name on macOS,
    // Linux and Windows.
    expect(branch).toBe("ade-app-42-windows-path-c-users-me-and-a-hash");
    expect(branch).not.toMatch(/[\\/#:]/);
  });

  it("falls back to a provider-named branch when the ref has no usable text", () => {
    expect(issueRefBranchName(ref({ key: "", title: "" }))).toBe("linear-issue");
    expect(issueRefBranchName(ref({ provider: "jira", key: "...", title: "" }))).toBe("jira-issue");
  });
});

describe("issueRefFormat PR references", () => {
  it("emits the provider's own closing word when the close is real", () => {
    expect(issueRefPrMagicWord(ref(), true)).toBe("Fixes");
    expect(issueRefPrReference(ref(), true)).toBe("Fixes ADE-123");
    const github = ref({ provider: ISSUE_PROVIDER_GITHUB, key: "ade/app#42" });
    expect(issueRefPrMagicWord(github, true)).toBe("Closes");
    expect(issueRefPrReference(github, true)).toBe("Closes ade/app#42");
  });

  it("emits Refs when the caller does not want a close", () => {
    expect(issueRefPrReference(ref(), false)).toBe("Refs ADE-123");
    expect(issueRefPrReference(ref({ provider: ISSUE_PROVIDER_GITHUB, key: "ade/app#42" }), false))
      .toBe("Refs ade/app#42");
  });

  it("never promises a close ADE cannot deliver for an unknown provider", () => {
    const jira = ref({ provider: "jira", key: "ABC-12", issueId: "10001" });
    // `Fixes ABC-12` is inert text on GitHub and no integration is listening,
    // so `closeOnMerge` must not upgrade the word.
    expect(issueRefSupportsCloseOnMerge(jira)).toBe(false);
    expect(issueRefPrMagicWord(jira, true)).toBe("Refs");
    expect(issueRefPrReference(jira, true)).toBe("Refs ABC-12");
    expect(issueRefPrReference(jira, false)).toBe("Refs ABC-12");
  });

  it("recognizes a provider written in mixed case", () => {
    expect(issueRefPrMagicWord(ref({ provider: "Linear" }), true)).toBe("Fixes");
    expect(issueRefSupportsCloseOnMerge(ref({ provider: " GITHUB " }))).toBe(true);
  });
});

describe("dedupeIssueRefs", () => {
  it("keeps two trackers that mint the same id string apart", () => {
    const github = ref({ provider: ISSUE_PROVIDER_GITHUB, issueId: "42", key: "ade/app#42" });
    const jira = ref({ provider: "jira", issueId: "42", key: "ABC-42" });
    const deduped = dedupeIssueRefs([{ issue: github }, { issue: jira }]);
    expect(deduped.map((entry) => entry.issue.provider)).toEqual([ISSUE_PROVIDER_GITHUB, "jira"]);
  });

  it("keeps the first occurrence of a repeated issue and preserves order", () => {
    const first = { issue: ref({ issueId: "issue-1" }), closeOnMerge: true };
    const second = { issue: ref({ issueId: "issue-2", key: "OPS-9" }), closeOnMerge: false };
    const repeat = { issue: ref({ issueId: "issue-1" }), closeOnMerge: false };
    expect(dedupeIssueRefs([first, second, repeat])).toEqual([first, second]);
  });

  it("falls back to the key when a ref carries no issue id", () => {
    const lower = { issue: ref({ issueId: "", key: "ade-1" }) };
    const upper = { issue: ref({ issueId: "", key: "ADE-1" }) };
    expect(dedupeIssueRefs([lower, upper])).toHaveLength(1);
  });
});

const JIRA = ref({
  pluginId: "jira-plugin",
  provider: "jira",
  issueId: "10001",
  key: "ABC-12",
  title: "Third party issue",
  url: "https://example.atlassian.net/browse/ABC-12",
});

describe("issueProviderLabel", () => {
  it("derives a heading name from the provider without a lookup table", () => {
    expect(issueProviderLabel(ISSUE_PROVIDER_LINEAR)).toBe("Linear");
    expect(issueProviderLabel("jira")).toBe("Jira");
    expect(issueProviderLabel("SHORTCUT")).toBe("Shortcut");
    expect(issueProviderLabel("azure-devops")).toBe("Azure-Devops");
    expect(issueProviderLabel("")).toBe("Issue");
  });

  it("leaves the two providers that own their own renderers to those renderers", () => {
    expect(issueRefUsesGenericLinkSection(ref())).toBe(false);
    expect(issueRefUsesGenericLinkSection(ref({ provider: ISSUE_PROVIDER_GITHUB }))).toBe(false);
    expect(issueRefUsesGenericLinkSection(JIRA)).toBe(true);
  });
});

describe("renderIssueRefPrLinkSection", () => {
  it("renders a Linear section byte-identically to renderLinearPrIssueLinkSection", () => {
    const primary = ref();
    const secondary = ref({ issueId: "issue-2", key: "OPS-9", title: "Update ops hooks" });
    const generic = renderIssueRefPrLinkSection(ISSUE_PROVIDER_LINEAR, [
      { issue: primary, closeOnMerge: true },
      { issue: secondary, closeOnMerge: false },
    ]);
    const legacy = renderLinearPrIssueLinkSection([
      { issue: issueRefToLinearIssue(primary), closeOnMerge: true },
      { issue: issueRefToLinearIssue(secondary), closeOnMerge: false },
    ]);
    expect(generic).toBe(legacy);
  });

  it("names the section and its markers after the provider", () => {
    const section = renderIssueRefPrLinkSection("jira", [{ issue: JIRA, closeOnMerge: false }]);
    expect(section).toBe(
      "<!-- ade:jira-links v=1 -->\n"
      + "### Linked Jira issues\n"
      + "\n"
      + "- [ABC-12: Third party issue](https://example.atlassian.net/browse/ABC-12) - referenced\n"
      + "<!-- /ade:jira-links -->",
    );
  });

  it("never says a third-party issue closes on merge", () => {
    // The disposition tracks what actually happens, exactly like the magic
    // word: nothing closes a Jira issue when this PR merges.
    const section = renderIssueRefPrLinkSection("jira", [{ issue: JIRA, closeOnMerge: true }]);
    expect(section).toContain("- referenced");
    expect(section).not.toContain("closes on merge");
  });

  it("keeps a provider name with regex metacharacters out of the markers", () => {
    const section = renderIssueRefPrLinkSection("we(ird)*", [
      { issue: ref({ provider: "we(ird)*", key: "W-1" }), closeOnMerge: false },
    ]);
    expect(section).toContain("<!-- ade:we-ird-links v=1 -->");
    expect(section).toContain("<!-- /ade:we-ird-links -->");
  });
});

describe("ensureIssueRefPrLinkSections", () => {
  const shortcut = ref({
    provider: "shortcut",
    issueId: "sc-1",
    key: "sc-5000",
    title: "Ship the thing",
    url: "https://app.shortcut.com/story/5000",
  });

  it("writes one section per tracker and leaves the body's prose alone", () => {
    const body = ensureIssueRefPrLinkSections("Summary\n", [
      { issue: JIRA, closeOnMerge: false },
      { issue: shortcut, closeOnMerge: false },
    ]);
    expect(body.startsWith("Summary\n")).toBe(true);
    expect(body).toContain("### Linked Jira issues");
    expect(body).toContain("### Linked Shortcut issues");
    expect(body.indexOf("ade:jira-links")).toBeLessThan(body.indexOf("ade:shortcut-links"));
  });

  it("is idempotent: a second write replaces each section in place", () => {
    const refs = [{ issue: JIRA, closeOnMerge: false }, { issue: shortcut, closeOnMerge: false }];
    const once = ensureIssueRefPrLinkSections("Summary\n", refs);
    const twice = ensureIssueRefPrLinkSections(once, refs);
    expect(twice).toBe(once);
    expect(twice.match(/<!-- ade:jira-links/g)).toHaveLength(1);
    expect(twice.match(/<!-- ade:shortcut-links/g)).toHaveLength(1);
  });

  it("does not touch the Linear or GitHub sections another writer owns", () => {
    const withLinear = "Fixes ADE-123\n\nSummary\n\n"
      + "<!-- ade:linear-links v=1 -->\n### Linked Linear issues\n\n- ADE-123\n<!-- /ade:linear-links -->\n"
      + "<!-- ade:github-links v=1 -->\n### Linked GitHub issues\n\n- ade/app#42\n<!-- /ade:github-links -->\n";
    const body = ensureIssueRefPrLinkSections(withLinear, [{ issue: JIRA, closeOnMerge: false }]);
    expect(body).toContain("<!-- ade:linear-links v=1 -->");
    expect(body).toContain("<!-- /ade:linear-links -->");
    expect(body).toContain("<!-- ade:github-links v=1 -->");
    expect(body).toContain("### Linked Jira issues");
  });

  it("sweeps a section whose tracker no longer has a link", () => {
    const both = ensureIssueRefPrLinkSections("Summary\n", [
      { issue: JIRA, closeOnMerge: false },
      { issue: shortcut, closeOnMerge: false },
    ]);
    const only = ensureIssueRefPrLinkSections(both, [{ issue: JIRA, closeOnMerge: false }]);
    expect(only).toContain("### Linked Jira issues");
    expect(only).not.toContain("ade:shortcut-links");
    expect(only).not.toContain("Ship the thing");
  });

  it("leaves the body alone when there is nothing to say", () => {
    const body = "Summary\n\n<!-- ade:jira-links v=1 -->\n### Linked Jira issues\n\n- x\n<!-- /ade:jira-links -->\n";
    // Matches applyLinearPrLinkage: a momentarily empty read must not strip a
    // section off a live PR.
    expect(ensureIssueRefPrLinkSections(body, [])).toBe(body);
  });

  it("strips an orphaned opener before appending a fresh section", () => {
    // Someone hand-edited the closing marker away. Exactly the Linear
    // renderer's repair, and exactly as far as it goes: the orphaned opener is
    // removed so the section cannot double, while the stranded lines below it
    // stay as prose — deleting body text nobody asked us to delete is worse
    // than leaving it.
    const corrupted = "Summary\n\n<!-- ade:jira-links v=1 -->\n### Linked Jira issues\n- old stuff\n";
    const repaired = ensureIssueRefPrLinkSections(corrupted, [{ issue: JIRA, closeOnMerge: false }]);
    expect(repaired.match(/<!-- ade:jira-links/g)).toHaveLength(1);
    expect(repaired.match(/<!-- \/ade:jira-links -->/g)).toHaveLength(1);
    expect(repaired).toContain("- [ABC-12: Third party issue]");
    expect(ensureIssueRefPrLinkSections(repaired, [{ issue: JIRA, closeOnMerge: false }])).toBe(repaired);
  });
});

describe("ensureIssueRefPrReferences", () => {
  it("prepends one Refs line per issue, in order", () => {
    const body = ensureIssueRefPrReferences("body", [
      { issue: JIRA, closeOnMerge: true },
      { issue: ref({ provider: "jira", issueId: "10002", key: "ABC-13" }), closeOnMerge: false },
    ], { preserveExisting: false });
    expect(body).toBe("Refs ABC-12\n\nRefs ABC-13\n\nbody");
  });

  it("does not duplicate a reference the body already carries", () => {
    const once = ensureIssueRefPrReferences("body", [{ issue: JIRA, closeOnMerge: false }]);
    expect(ensureIssueRefPrReferences(once, [{ issue: JIRA, closeOnMerge: false }])).toBe(once);
    // A hand-written closing word counts as already-referenced.
    expect(ensureIssueRefPrReferences("Fixes ABC-12\n\nbody", [{ issue: JIRA, closeOnMerge: false }]))
      .toBe("Fixes ABC-12\n\nbody");
  });

  it("skips a ref with no key rather than writing a bare magic word", () => {
    expect(ensureIssueRefPrReferences("body", [{ issue: ref({ provider: "jira", key: "" }), closeOnMerge: true }]))
      .toBe("body");
  });
});
