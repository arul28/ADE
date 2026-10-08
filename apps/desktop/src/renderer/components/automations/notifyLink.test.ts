import { describe, expect, it } from "vitest";

import { buildNotifyLink, checkNotifyLink, readNotifyLink, type NotifyLink } from "./notifyLink";

/**
 * The "When tapped, open" picker builds the link from fields a person fills
 * in, and reads a saved link back into those fields when the step is edited.
 * Every choice must make a link ADE opens, keep `{{…}}` values intact for the
 * run to fill in, and survive a save-and-reopen.
 */
describe("notification step link picker", () => {
  it.each<[string, NotifyLink, string]>([
    ["just ADE", { kind: "none", fields: {} }, ""],
    ["Activity on a column", { kind: "activity", fields: { column: "waiting" } }, "ade://activity?state=waiting"],
    ["the trigger's chat", { kind: "chat", fields: { sessionId: "{{trigger.session.sessionId}}" } }, "ade://session/{{trigger.session.sessionId}}"],
    ["a pull request number with a #", { kind: "pr", fields: { prNumber: "#1515" } }, "ade://pr/1515"],
    ["the trigger's PR in a repo", { kind: "pr", fields: { prNumber: "{{trigger.pr.number}}", repo: "arul28/ADE" } }, "ade://pr/arul28/ADE/{{trigger.pr.number}}"],
    ["a Linear issue typed in lower case", { kind: "linear", fields: { linearIssue: "ade-123" } }, "ade://linear-issue/ADE-123"],
    ["a Linear issue built from a variable", { kind: "linear", fields: { linearIssue: "ade-{{trigger.issue.number}}" } }, "ade://linear-issue/ADE-{{trigger.issue.number}}"],
    ["the run's lane", { kind: "lane", fields: { laneId: "{{trigger.lane.id}}" } }, "ade://lane/{{trigger.lane.id}}"],
    ["a file line in a lane", { kind: "file", fields: { path: "apps/desktop/src/main.ts", line: "40", laneId: "ce3acd58-0736-4316-af65-1dd2dcaf2bba" } }, "ade://file/apps/desktop/src/main.ts?line=40&lane=ce3acd58-0736-4316-af65-1dd2dcaf2bba"],
    ["a commit", { kind: "commit", fields: { sha: "708b303ee" } }, "ade://commit/708b303ee"],
    ["a branch with a slash and a space", { kind: "branch", fields: { repo: "arul28/ADE", branch: "ade/feature x" } }, "ade://repo/arul28/ADE/branch/ade/feature%20x"],
    ["proof", { kind: "proof", fields: { artifactId: "34b93299-f559-4318-8142-6c31e2b847b3" } }, "ade://artifact/34b93299-f559-4318-8142-6c31e2b847b3"],
  ])("builds %s, which opens and reads back unchanged", (_name, link, built) => {
    expect(buildNotifyLink(link)).toBe(built);
    const reread = readNotifyLink(built);
    expect(reread.kind).toBe(link.kind);
    expect(buildNotifyLink(reread)).toBe(built);
    expect(checkNotifyLink(built).state).toBe(built ? "ok" : "empty");
  });

  it("opens a link it did not build as a pasted link, unchanged", () => {
    const pasted = "ade://session/abc?item=1&accountMachineKey=mk&projectId=p";
    expect(readNotifyLink(pasted)).toEqual({ kind: "custom", fields: { custom: pasted } });
    expect(buildNotifyLink(readNotifyLink(pasted))).toBe(pasted);
  });

  it("says a link uses trigger values, and names what cannot open", () => {
    expect(checkNotifyLink("ade://pr/{{trigger.pr.number}}")).toMatchObject({ state: "ok", checkedWithSamples: true });
    expect(checkNotifyLink("ade://pr/1515")).toMatchObject({ state: "ok", checkedWithSamples: false });
    expect(checkNotifyLink("ade://prs")).toMatchObject({ state: "problem" });
    // An unfilled required field builds nothing, which the editor asks about.
    expect(buildNotifyLink({ kind: "chat", fields: {} })).toBe("");
  });
});
