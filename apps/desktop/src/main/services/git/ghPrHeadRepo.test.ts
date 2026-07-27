import { describe, expect, it } from "vitest";

import {
  GH_PR_LIST_JSON_FIELDS,
  GH_PR_LIST_LEGACY_JSON_FIELDS,
  ghPrHeadRepoMatchesLane,
  parseGhPrListEntry,
  selectOwnRepoOpenPr,
} from "./ghPrHeadRepo";

function ghRow(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://github.com/acme/widgets/pull/12",
    number: 12,
    title: "Fix auth",
    headRefName: "hotfix-auth",
    headRepositoryOwner: { id: "MDQ6VXNlcjE=", login: "acme" },
    headRepository: { id: "R_1", name: "widgets" },
    ...overrides,
  };
}

describe("GH_PR_LIST_JSON_FIELDS", () => {
  it("requests the head-repository fields the fork filter needs", () => {
    expect(GH_PR_LIST_JSON_FIELDS.split(",")).toEqual([
      "url",
      "number",
      "title",
      "headRefName",
      "headRepositoryOwner",
      "headRepository",
    ]);
  });
});

describe("parseGhPrListEntry", () => {
  it("decodes the modern gh object shapes", () => {
    expect(parseGhPrListEntry(ghRow())).toEqual({
      url: "https://github.com/acme/widgets/pull/12",
      number: 12,
      title: "Fix auth",
      headRefName: "hotfix-auth",
      headRepositoryOwner: "acme",
      headRepositoryName: "widgets",
    });
  });

  it("gh < 2.47: omits headRepositoryOwner/headRepository without dropping the PR", () => {
    const entry = parseGhPrListEntry({
      url: "https://github.com/acme/widgets/pull/12",
      number: 12,
      title: "Fix auth",
      headRefName: "hotfix-auth",
    });

    expect(entry).not.toBeNull();
    expect(entry?.headRepositoryOwner).toBeNull();
    expect(entry?.headRepositoryName).toBeNull();
    expect(entry?.number).toBe(12);
  });

  it("accepts bare strings so a future gh shape change degrades gracefully", () => {
    const entry = parseGhPrListEntry(
      ghRow({ headRepositoryOwner: "acme", headRepository: "widgets" }),
    );
    expect(entry?.headRepositoryOwner).toBe("acme");
    expect(entry?.headRepositoryName).toBe("widgets");
  });

  it("returns null for non-objects", () => {
    expect(parseGhPrListEntry(null)).toBeNull();
    expect(parseGhPrListEntry("nope")).toBeNull();
    expect(parseGhPrListEntry([])).toBeNull();
  });
});

describe("ghPrHeadRepoMatchesLane", () => {
  it("accepts a PR whose head repo owner matches the lane remote owner", () => {
    expect(
      ghPrHeadRepoMatchesLane({ entry: { headRepositoryOwner: "acme" }, expectedOwner: "acme" }),
    ).toBe(true);
  });

  it("matches owners case-insensitively", () => {
    expect(
      ghPrHeadRepoMatchesLane({ entry: { headRepositoryOwner: "AcMe" }, expectedOwner: "acme" }),
    ).toBe(true);
  });

  it("rejects a PR opened from a fork with a colliding branch name", () => {
    expect(
      ghPrHeadRepoMatchesLane({ entry: { headRepositoryOwner: "mallory" }, expectedOwner: "acme" }),
    ).toBe(false);
  });

  it("gh < 2.47: an absent owner means 'cannot verify, accept' — never reject", () => {
    expect(
      ghPrHeadRepoMatchesLane({ entry: { headRepositoryOwner: null }, expectedOwner: "acme" }),
    ).toBe(true);
  });

  it("accepts when the lane remote owner is unknown (non-GitHub or unparseable origin)", () => {
    expect(
      ghPrHeadRepoMatchesLane({ entry: { headRepositoryOwner: "mallory" }, expectedOwner: null }),
    ).toBe(true);
    expect(
      ghPrHeadRepoMatchesLane({ entry: { headRepositoryOwner: "mallory" }, expectedOwner: "  " }),
    ).toBe(true);
  });
});

describe("selectOwnRepoOpenPr", () => {
  it("skips the fork PR and returns the lane's own PR further down the page", () => {
    const rawJson = JSON.stringify([
      ghRow({
        url: "https://github.com/acme/widgets/pull/99",
        number: 99,
        title: "Drive-by",
        headRepositoryOwner: { login: "mallory" },
        headRepository: { name: "widgets" },
      }),
      ghRow(),
    ]);

    expect(selectOwnRepoOpenPr({ rawJson, expectedOwner: "acme" })).toEqual({
      prUrl: "https://github.com/acme/widgets/pull/12",
      prNumber: 12,
      title: "Fix auth",
      headRefName: "hotfix-auth",
    });
  });

  it("returns the empty summary when every candidate is a fork PR", () => {
    const rawJson = JSON.stringify([ghRow({ headRepositoryOwner: { login: "mallory" } })]);

    expect(selectOwnRepoOpenPr({ rawJson, expectedOwner: "acme" })).toEqual({
      prUrl: null,
      prNumber: null,
      title: null,
      headRefName: null,
    });
  });

  it("gh < 2.47: keeps working when the payload has no head-repository fields at all", () => {
    const rawJson = JSON.stringify([
      {
        url: "https://github.com/acme/widgets/pull/12",
        number: 12,
        title: "Fix auth",
        headRefName: "hotfix-auth",
      },
    ]);

    expect(selectOwnRepoOpenPr({ rawJson, expectedOwner: "acme" })).toEqual({
      prUrl: "https://github.com/acme/widgets/pull/12",
      prNumber: 12,
      title: "Fix auth",
      headRefName: "hotfix-auth",
    });
  });

  it("degrades to the empty summary on empty, malformed, or non-array output", () => {
    const empty = { prUrl: null, prNumber: null, title: null, headRefName: null };
    expect(selectOwnRepoOpenPr({ rawJson: "", expectedOwner: "acme" })).toEqual(empty);
    expect(selectOwnRepoOpenPr({ rawJson: "not json", expectedOwner: "acme" })).toEqual(empty);
    expect(selectOwnRepoOpenPr({ rawJson: "{}", expectedOwner: "acme" })).toEqual(empty);
    expect(selectOwnRepoOpenPr({ rawJson: "[]", expectedOwner: "acme" })).toEqual(empty);
  });
});

/**
 * Regression: `gh` rejects an unknown --json field with a NON-ZERO EXIT rather
 * than omitting it, so simply asking for headRepositoryOwner against an older
 * CLI failed the entire lookup and reported "no open PR" for every lane. The
 * lenient per-entry decode never ran, because the process never succeeded.
 */
describe("gh legacy field fallback", () => {
  it("requests only fields that predate the head-repo additions", () => {
    const legacy = GH_PR_LIST_LEGACY_JSON_FIELDS.split(",");
    expect(legacy).toEqual(["url", "number", "title", "headRefName"]);
    // The whole point of the fallback is that it cannot reintroduce the fields
    // whose absence forced it.
    expect(legacy).not.toContain("headRepositoryOwner");
    expect(legacy).not.toContain("headRepository");
    expect(GH_PR_LIST_JSON_FIELDS.split(",")).toContain("headRepositoryOwner");
  });

  it("accepts a legacy-shaped row that carries no owner, rather than dropping the PR", () => {
    // Exactly what the fallback query returns: no headRepositoryOwner key at all.
    const rawJson = JSON.stringify([
      {
        url: "https://github.com/acme/widgets/pull/12",
        number: 12,
        title: "Fix auth",
        headRefName: "hotfix-auth",
      },
    ]);

    // Unverifiable owner must mean accept — degrading to pre-filter behavior —
    // never reject, which would hide the lane's own PR.
    expect(selectOwnRepoOpenPr({ rawJson, expectedOwner: "acme" })).toEqual({
      prUrl: "https://github.com/acme/widgets/pull/12",
      prNumber: 12,
      title: "Fix auth",
      headRefName: "hotfix-auth",
    });
  });
});
