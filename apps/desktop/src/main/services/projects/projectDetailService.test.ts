import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __internal, getProjectDetail } from "./projectDetailService";

const { parseLastCommitLine, parseAheadBehind } = __internal;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("parseLastCommitLine", () => {
  it("splits subject, iso date, and short sha on the unit separator", () => {
    const parsed = parseLastCommitLine("Fix thing\u001f2026-04-15T09:00:00Z\u001fabcdef1\n");
    expect(parsed).toEqual({
      subject: "Fix thing",
      isoDate: "2026-04-15T09:00:00Z",
      shortSha: "abcdef1",
    });
  });

  it("returns null when any segment is missing", () => {
    expect(parseLastCommitLine("")).toBeNull();
    expect(parseLastCommitLine("Fix thing\u001f2026-04-15T09:00:00Z")).toBeNull();
    expect(parseLastCommitLine("Fix thing\u001f\u001fabcdef1")).toBeNull();
  });
});

describe("parseAheadBehind", () => {
  it("reads the left-right count output (behind, ahead)", () => {
    expect(parseAheadBehind("3\t2\n")).toEqual({ ahead: 2, behind: 3 });
    expect(parseAheadBehind("0\t0")).toEqual({ ahead: 0, behind: 0 });
  });

  it("returns null when the output cannot be parsed", () => {
    expect(parseAheadBehind("")).toBeNull();
    expect(parseAheadBehind("abc")).toBeNull();
  });
});

describe("getProjectDetail", () => {
  it("rejects paths that are not existing directories", async () => {
    const root = makeTempDir("ade-project-detail-");
    const filePath = path.join(root, "README.md");
    fs.writeFileSync(filePath, "# hello\n", "utf8");

    await expect(getProjectDetail(filePath)).rejects.toThrow(/existing directory/i);
    await expect(getProjectDetail(path.join(root, "missing-project"))).rejects.toThrow(/existing directory/i);
  });

  it("strips repeated leading HTML comments from README excerpts", async () => {
    const root = makeTempDir("ade-project-detail-");
    fs.writeFileSync(
      path.join(root, "README.md"),
      "<!-- generated -->\n<!-- review -->\n# Hello\n\nVisible body.\n",
      "utf8",
    );

    const detail = await getProjectDetail(root);

    expect(detail.readmeExcerpt).toBe("# Hello\n\nVisible body.");
  });
});
