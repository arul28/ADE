import { describe, expect, it } from "vitest";
import { classifyPrAuthor, isPrBotAuthor, knownPrBotKinds } from "./prBotIdentity";
import { prChangesRequestedBy, resolvePrNextStep, resolvePrNextStepFromStatus, type PrNextStepInput } from "./prNextStep";
import {
  buildPrConversationDigest,
  describeBotGroup,
  digestPreview,
  isOpenThread,
  sectionIndexFor,
  ts,
  type PrDigestEntry,
} from "./prConversationDigest";
import { describeAutoMergeFailure } from "./prAutoMerge";

describe("classifyPrAuthor", () => {
  it("recognizes GraphQL bot logins that carry no [bot] suffix (PR #1285)", () => {
    // The exact logins GitHub GraphQL returned for #1285's reviewers.
    expect(classifyPrAuthor("coderabbitai").displayName).toBe("CodeRabbit");
    expect(classifyPrAuthor("devin-ai-integration").kind).toBe("devin");
    expect(classifyPrAuthor("cursor", true)).toMatchObject({ isBot: true, kind: "cursor", role: "agent-reviewer" });
  });

  it("recognizes REST logins with the [bot] suffix", () => {
    expect(classifyPrAuthor("vercel[bot]")).toMatchObject({ isBot: true, kind: "vercel", role: "deploy" });
    expect(classifyPrAuthor("dependabot[bot]").role).toBe("dependency");
    expect(classifyPrAuthor("some-new-app[bot]")).toMatchObject({ isBot: true, kind: null, role: "bot" });
  });

  it("does not call a person a bot because their login is a product word", () => {
    // A person can own `cursor` or `claude`; only GitHub's flag or suffix decides.
    expect(isPrBotAuthor("cursor")).toBe(false);
    expect(isPrBotAuthor("claude")).toBe(false);
    expect(classifyPrAuthor("arul28")).toMatchObject({ isBot: false, role: "human", displayName: "arul28" });
  });

  it("trusts the account flag for an unknown bot", () => {
    expect(classifyPrAuthor("acme-reviewer", true)).toMatchObject({ isBot: true, kind: null });
  });

  it("names Sentry's Seer reviewer as an agent reviewer", () => {
    expect(classifyPrAuthor("seer-by-sentry[bot]", true)).toMatchObject({ kind: "seer", displayName: "Seer", role: "agent-reviewer" });
  });

  it("keeps kinds unique so icon maps stay one-to-one", () => {
    const kinds = knownPrBotKinds();
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

const openPr: PrNextStepInput = {
  state: "open",
  mergeStateStatus: "clean",
  mergeConflicts: false,
  behindBaseBy: 0,
  mergeabilityComputing: false,
  checksStatus: "passing",
  checks: { failing: 0, pending: 0, passing: 5 },
  reviewDecision: null,
  approvalsCount: null,
  requiredApprovals: null,
  changesRequestedBy: [],
  unresolvedThreads: 0,
  canBypass: false,
  autoMergeAllowed: false,
  autoMergeEnabled: false,
  autoMergeMethod: null,
  baseBranch: "main",
};

describe("resolvePrNextStep", () => {
  it("leads with conflicts on PR #1285 and blocks merge anyway", () => {
    const step = resolvePrNextStep({
      ...openPr,
      mergeStateStatus: "dirty",
      mergeConflicts: true,
      checksStatus: "pending",
      checks: { failing: 0, pending: 1, passing: 4 },
      unresolvedThreads: 1,
      canBypass: true,
    });
    expect(step).toMatchObject({ kind: "conflicts", primary: "resolve_conflicts", tone: "danger" });
    expect(step.mergeAnyway).toMatchObject({ visible: true, blocked: true, bypass: false });
    expect(step.chips.map((chip) => [chip.id, chip.state])).toEqual([
      ["conflicts", "fail"],
      ["up_to_date", "pass"],
      ["checks", "pending"],
      ["review", "neutral"],
      ["threads", "pending"],
    ]);
  });

  it("says GitHub is checking while mergeability reads unknown, not ready", () => {
    const step = resolvePrNextStep({ ...openPr, mergeStateStatus: "unknown", mergeabilityComputing: true });
    expect(step).toMatchObject({ kind: "computing", primary: null });
    // An unknown box proves nothing about conflicts.
    expect(step.chips.map((chip) => chip.id)).not.toContain("conflicts");
  });

  it("walks the priority order", () => {
    expect(resolvePrNextStep({ ...openPr, state: "merged" }).kind).toBe("merged");
    expect(resolvePrNextStep({ ...openPr, state: "draft", mergeStateStatus: "draft" }).primary).toBe("ready_for_review");
    expect(resolvePrNextStep({ ...openPr, mergeStateStatus: "behind", behindBaseBy: 3 }).headline).toBe("3 commits behind main");
    expect(resolvePrNextStep({ ...openPr, checks: { failing: 2, pending: 1, passing: 2 } })).toMatchObject({
      kind: "checks_failing", primary: "fix_checks", secondary: "rerun_checks",
    });
    expect(resolvePrNextStep({ ...openPr, changesRequestedBy: ["reviewer"] }).kind).toBe("changes_requested");
    expect(resolvePrNextStep({ ...openPr, reviewDecision: "review_required", requiredApprovals: 1, approvalsCount: 0, mergeStateStatus: "blocked" }).headline)
      .toBe("Needs 1 approval");
  });

  it("offers auto-merge while checks run only when the repo allows it", () => {
    const running = { ...openPr, checks: { failing: 0, pending: 2, passing: 3 }, mergeStateStatus: "blocked" as const };
    expect(resolvePrNextStep(running).primary).toBeNull();
    expect(resolvePrNextStep({ ...running, autoMergeAllowed: true }).primary).toBe("enable_auto_merge");
    expect(resolvePrNextStep({ ...running, autoMergeEnabled: true, autoMergeMethod: "squash" })).toMatchObject({
      kind: "auto_merge_armed", headline: "Auto-merge on · squash", secondary: "disable_auto_merge",
    });
  });

  it("lets an admin bypass protection and lists what it skips", () => {
    const step = resolvePrNextStep({
      ...openPr,
      mergeStateStatus: "blocked",
      reviewDecision: "review_required",
      requiredApprovals: 1,
      approvalsCount: 0,
      checks: { failing: 0, pending: 1, passing: 4 },
      canBypass: true,
    });
    expect(step.mergeAnyway).toMatchObject({ visible: true, blocked: false, bypass: true });
    expect(step.mergeAnyway.skips).toEqual(["1 running check", "1 required approval"]);
  });

  it("disables merge anyway for a non-admin when rules block", () => {
    const step = resolvePrNextStep({ ...openPr, mergeStateStatus: "blocked", reviewDecision: "review_required" });
    expect(step.mergeAnyway).toMatchObject({ blocked: true, bypass: false });
  });

  it("never says ready over a blocked verdict it cannot explain", () => {
    const step = resolvePrNextStep({ ...openPr, mergeStateStatus: "blocked", unresolvedThreads: 2 });
    expect(step).toMatchObject({ kind: "rules_blocked", primary: "fix_threads" });
  });

  it("merges directly when ready, with open threads as a nudge", () => {
    const step = resolvePrNextStep({ ...openPr, unresolvedThreads: 1 });
    expect(step).toMatchObject({ kind: "ready", primary: "merge", secondary: "fix_threads" });
    expect(step.mergeAnyway.visible).toBe(false);
  });

  it("does not claim no conflicts without a live merge box", () => {
    const step = resolvePrNextStep({ ...openPr, mergeStateStatus: null, behindBaseBy: null });
    expect(step.chips.some((chip) => chip.id === "conflicts" || chip.id === "up_to_date")).toBe(false);
  });

  it("says no CI ran instead of counting third-party rows (ADE-135)", () => {
    const step = resolvePrNextStep({ ...openPr, checksStatus: "not_run", checks: { failing: 0, pending: 0, passing: 3 } });
    expect(step.chips.find((chip) => chip.id === "checks")).toMatchObject({ state: "neutral", label: "No CI ran" });
  });
});

describe("buildPrConversationDigest", () => {
  const push = (sha: string, at: string) => ({ id: `commit:${sha}`, sha, shortSha: sha.slice(0, 7), subject: `commit ${sha}`, at, commitCount: 1, forcePushed: false });
  const thread = (id: string, author: string, at: string, resolved: boolean, authorIsBot = true): PrDigestEntry => ({
    id, kind: "thread", author, authorIsBot, avatarUrl: null, at, body: `Finding ${id}. More detail.`, url: null,
    path: "apps/desktop/src/main/services/usage/usagePricing.ts", line: 307, resolved, outdated: false,
  });

  it("pins the one open Devin thread and folds the rest per bot per push", () => {
    const entries: PrDigestEntry[] = [
      ...Array.from({ length: 3 }, (_, i) => thread(`cr${i}`, "coderabbitai", "2026-09-22T10:10:00Z", true)),
      ...Array.from({ length: 11 }, (_, i) => thread(`dv${i}`, "devin-ai-integration", "2026-09-22T10:20:00Z", true)),
      thread("dv-open", "devin-ai-integration", "2026-09-22T11:05:00Z", false),
      ...Array.from({ length: 2 }, (_, i) => thread(`cu${i}`, "cursor", "2026-09-22T11:06:00Z", true)),
      { id: "c1", kind: "comment", author: "vercel[bot]", authorIsBot: true, avatarUrl: null, at: "2026-09-22T10:01:00Z", body: "Deployed", url: null },
      { id: "c2", kind: "comment", author: "arul28", avatarUrl: null, at: "2026-09-22T11:10:00Z", body: "Handled in b07e4b5.", url: null },
    ];
    const digest = buildPrConversationDigest({
      pushes: [push("9ac1e02", "2026-09-22T10:00:00Z"), push("b07e4b5", "2026-09-22T11:00:00Z")],
      entries,
    });
    expect(digest.needsAttention.map((item) => item.entry.id)).toEqual(["dv-open"]);
    const [first, second] = digest.sections;
    expect(first!.bots.map((group) => [group.identity.displayName, describeBotGroup(group)])).toEqual([
      ["Vercel", "Deploy update"],
      ["CodeRabbit", "3 threads · all resolved"],
      ["Devin", "11 threads · all resolved"],
    ]);
    expect(second!.bots.map((group) => [group.identity.displayName, describeBotGroup(group)])).toEqual([
      ["Devin", "1 thread · 1 open"],
      ["Cursor", "2 threads · all resolved"],
    ]);
    expect(second!.humans.map((entry) => entry.id)).toEqual(["c2"]);
  });

  it("finds the section of a time by the last push at or before it", () => {
    const starts = [ts("2026-09-22T10:00:00Z"), ts("2026-09-22T11:00:00Z")];
    expect(sectionIndexFor(starts, "2026-09-22T09:59:59Z")).toBe(-1);
    expect(sectionIndexFor(starts, "2026-09-22T10:00:00Z")).toBe(0);
    expect(sectionIndexFor(starts, "2026-09-22T12:00:00Z")).toBe(1);
    expect(sectionIndexFor([], "2026-09-22T12:00:00Z")).toBe(-1);
    // A bad time sorts first, before every push.
    expect(ts("not a date")).toBe(0);
    expect(sectionIndexFor(starts, "not a date")).toBe(-1);
  });

  it("counts only unresolved, current threads as open", () => {
    expect(isOpenThread({ kind: "thread", resolved: false, outdated: false })).toBe(true);
    expect(isOpenThread({ kind: "thread", resolved: true, outdated: false })).toBe(false);
    expect(isOpenThread({ kind: "thread", resolved: false, outdated: true })).toBe(false);
    expect(isOpenThread({ kind: "comment" })).toBe(false);
  });

  it("keeps activity before the first push in a leading section", () => {
    const digest = buildPrConversationDigest({
      pushes: [push("aaa", "2026-09-22T12:00:00Z")],
      entries: [{ id: "early", kind: "comment", author: "arul28", avatarUrl: null, at: "2026-09-22T09:00:00Z", body: "hi", url: null }],
    });
    expect(digest.sections[0]!.push).toBeNull();
    expect(digest.sections[0]!.humans).toHaveLength(1);
  });

  it("puts human findings ahead of bot findings", () => {
    const digest = buildPrConversationDigest({
      pushes: [],
      entries: [thread("bot", "coderabbitai", "2026-09-22T12:00:00Z", false), thread("human", "octocat", "2026-09-22T11:00:00Z", false, false)],
    });
    expect(digest.needsAttention.map((item) => item.entry.id)).toEqual(["human", "bot"]);
  });
});

describe("digestPreview", () => {
  it("strips bot markup and keeps the first sentence", () => {
    const body = "<!-- rabbit -->**Stale rates kept.** The fallback keeps expired models.dev rates. <details>big</details>";
    expect(digestPreview(body)).toBe("Stale rates kept.");
  });
});

describe("describeAutoMergeFailure", () => {
  it("names the repo setting when auto-merge is off", () => {
    expect(describeAutoMergeFailure("Pull request Auto merge is not allowed for this repository", "arul28/ADE"))
      .toContain('Turn on "Allow auto-merge"');
  });
  it("says to merge when the PR is already clean", () => {
    expect(describeAutoMergeFailure("Pull request is in clean status", "arul28/ADE")).toContain("Merge it instead");
  });
  it("keeps GitHub's words for an unknown error", () => {
    expect(describeAutoMergeFailure("Something new", "a/b")).toBe("GitHub refused auto-merge: Something new");
  });
});

describe("prChangesRequestedBy", () => {
  it("keeps each reviewer's latest opinion and ignores later plain comments", () => {
    const at = (h: number) => `2026-01-01T0${h}:00:00Z`;
    expect(prChangesRequestedBy([
      { reviewer: "alice", state: "changes_requested", submittedAt: at(1) },
      { reviewer: "alice", state: "commented", submittedAt: at(2) },
      { reviewer: "bob", state: "changes_requested", submittedAt: at(1) },
      { reviewer: "bob", state: "approved", submittedAt: at(3) },
    ])).toEqual(["alice"]);
  });

  it("lets a later dismissal clear a verdict and sorts pending reviews without a time", () => {
    const at = (h: number) => `2026-01-01T0${h}:00:00Z`;
    expect(prChangesRequestedBy([
      { reviewer: "alice", state: "changes_requested", submittedAt: at(1) },
      { reviewer: "alice", state: "dismissed", submittedAt: at(2) },
      { reviewer: "carol", state: "pending", submittedAt: null },
      { reviewer: "Carol[bot]", state: "changes_requested", submittedAt: at(3) },
    ])).toEqual(["Carol[bot]"]);
  });

  it("uses the PR row's values when the status does not report them", () => {
    const step = resolvePrNextStepFromStatus({
      state: "open",
      baseBranch: "main",
      status: {},
      checks: { failing: 0, pending: 0, passing: 2 },
      reviews: [],
      unresolvedThreads: 0,
      fallback: { mergeConflicts: true },
    });
    expect(step.kind).toBe("conflicts");
  });

  it("feeds the status-based next step used by the TUI", () => {
    const step = resolvePrNextStepFromStatus({
      state: "open",
      baseBranch: "main",
      status: { mergeStateStatus: "clean" },
      checks: { failing: 0, pending: 0, passing: 2 },
      reviews: [{ reviewer: "alice", state: "changes_requested", submittedAt: "2026-01-01T00:00:00Z" }],
      unresolvedThreads: 0,
    });
    expect(step).toMatchObject({ kind: "changes_requested", detail: "By alice" });
  });
});

describe("splitPrBodyBotSections", () => {
  it("takes the bot blocks out of the description and keeps each as that bot's text", async () => {
    const { splitPrBodyBotSections } = await import("./prBodyBotSections");
    const body = [
      "## Why",
      "New models.",
      "",
      "---",
      "<!-- devin-review-badge-begin -->",
      "<a href=\"https://app.devin.ai/review/x\">Devin Review</a>",
      "<!-- devin-review-badge-end -->",
      "",
      "<!-- CURSOR_SUMMARY -->",
      "> [!NOTE]",
      "> Medium risk.",
      "<!-- /CURSOR_SUMMARY -->",
      "",
      "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->",
      "## Summary by CodeRabbit",
      "* New features",
      "<!-- end of auto-generated comment: release notes by coderabbit.ai -->",
    ].join("\n");
    const split = splitPrBodyBotSections(body);
    expect(split.body).toBe("## Why\nNew models.");
    expect(split.sections.map((section) => section.login)).toEqual(["coderabbitai", "cursor", "devin-ai-integration"]);
    expect(split.sections[0]!.body).toContain("## Summary by CodeRabbit");
    expect(split.sections[1]!.body).toContain("Medium risk.");
  });

  it("leaves a description without bot blocks alone", async () => {
    const { splitPrBodyBotSections } = await import("./prBodyBotSections");
    expect(splitPrBodyBotSections("Plain body.")).toEqual({ body: "Plain body.", sections: [] });
  });
});
