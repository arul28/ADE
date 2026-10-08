import { describe, expect, it } from "vitest";

import { normalizeCustomNotificationLink, stampCustomNotificationLinkOwner } from "./customNotificationLink";
import { customNotificationProblem } from "./types/attention";

describe("custom notification links", () => {
  /**
   * A notification's link is tapped on the phone, so only a link ADE opens may
   * go out. An empty trigger value used to make `ade://pr/`, which the old
   * `ade://` prefix check sent as a dead tap.
   */
  it.each([
    ["a chat", "ade://session/94a2b987-9f9f-45bc-a01c-2b2a13b20c55", "ade://session/94a2b987-9f9f-45bc-a01c-2b2a13b20c55"],
    ["a pull request by number alone", "ade://pr/1515", "ade://pr/1515"],
    ["a pull request in a repo", "ade://pr/arul28/ADE/1515?tab=checks", "ade://pr/arul28/ADE/1515?tab=checks"],
    ["Activity", "ade://activity", "ade://activity"],
    ["Activity on one column", "ade://activity?state=needs_you", "ade://activity?state=needs_you"],
    ["just ADE", "ade://workspace", "ade://workspace"],
    ["a Linear issue", "ade://linear-issue/ADE-123", "ade://linear-issue/ADE-123"],
    ["a shareable https link, as ade://", "https://ade-app.dev/open?type=pr&number=12&repo=arul28/ADE", "ade://pr/arul28/ADE/12"],
  ])("accepts %s", (_name, raw, link) => {
    expect(normalizeCustomNotificationLink(raw)).toEqual({ ok: true, link });
    expect(customNotificationProblem({ title: "t", open: raw })).toBeNull();
  });

  it.each([
    ["an empty trigger value", "ade://pr/", /can't open/],
    ["a made-up place", "ade://prs", /can't open/],
    ["a web page", "https://example.com/phish", /can't open/],
    ["an old six-group column", "ade://activity?state=idle", /must be one of/],
    ["a lane that is not a lane id", "ade://lane/not-a-uuid", /can't open/],
    ["plain text", "deploy page", /is not a link/],
  ])("refuses %s", (_name, raw, problem) => {
    const result = normalizeCustomNotificationLink(raw);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.problem).toMatch(problem);
    expect(customNotificationProblem({ title: "t", open: raw })).toMatch(problem);
  });

  /**
   * The phone opens a chat or PR on the machine the link names; a link that
   * names none would open on whichever machine is in front.
   */
  it.each([
    ["a chat", "ade://session/abc", "ade://session/abc?accountMachineKey=mk&projectId=project_1"],
    ["a pull request", "ade://pr/12?tab=checks", "ade://pr/12?tab=checks&accountMachineKey=mk&projectId=project_1"],
    ["a lane, which the phone hands to the computer", "ade://lane/abc", "ade://lane/abc"],
    ["a chat that already names its machine", "ade://session/abc?accountMachineKey=other&projectId=p", "ade://session/abc?accountMachineKey=other&projectId=p"],
  ])("stamps the sending machine onto %s only when it names none", (_name, link, stamped) => {
    expect(stampCustomNotificationLinkOwner(link, { accountMachineKey: "mk", projectId: "project_1" })).toBe(stamped);
  });

  it("stamps nothing without both a machine and a project", () => {
    expect(stampCustomNotificationLinkOwner("ade://session/abc", { accountMachineKey: "mk", projectId: null })).toBe("ade://session/abc");
    expect(stampCustomNotificationLinkOwner("ade://session/abc", { accountMachineKey: null, projectId: "p" })).toBe("ade://session/abc");
  });
});
