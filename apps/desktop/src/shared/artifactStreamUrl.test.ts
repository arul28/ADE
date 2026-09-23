import { describe, expect, it } from "vitest";
import {
  localArtifactMediaUrl,
  localArtifactStreamUrl,
  parseArtifactMediaPath,
  projectRelativeArtifactPath,
  remoteArtifactMediaUrl,
} from "./artifactStreamUrl";

const BASE = "http://127.0.0.1:5000/tok";

/** The part of a media URL the server parses. */
function afterBase(url: string | null): string {
  expect(url?.startsWith(`${BASE}/`)).toBe(true);
  return url!.slice(BASE.length + 1);
}

describe("proof stream URLs", () => {
  const root = "/Users/me/repo";

  it("maps every in-project form to the range-capable project URL", () => {
    // The owner's 2026-09-23 report: a recording filed with a project-relative
    // uri never matched the protocol and fell back to a 10 MB data URL.
    expect(localArtifactStreamUrl(".ade/artifacts/apple-recordings/lane-1/rec.mp4", root))
      .toBe("ade-artifact://project/.ade/artifacts/apple-recordings/lane-1/rec.mp4");
    expect(localArtifactStreamUrl("ade-artifact://project/.ade/artifacts/proof.mov", root))
      .toBe("ade-artifact://project/.ade/artifacts/proof.mov");
    expect(localArtifactStreamUrl(`${root}/.ade/artifacts/a b#1.mp4`, root))
      .toBe("ade-artifact://project/.ade/artifacts/a%20b%231.mp4");
    expect(localArtifactStreamUrl("./.ade/artifacts/x.png", root))
      .toBe("ade-artifact://project/.ade/artifacts/x.png");
    expect(localArtifactStreamUrl("C:\\repo\\.ade\\artifacts\\x.mp4", "C:\\Repo"))
      .toBe("ade-artifact://project/.ade/artifacts/x.mp4");
  });

  it("compares a root without case on Windows-shaped roots and case-folding hosts only", () => {
    // UNC roots fold like drive roots.
    expect(projectRelativeArtifactPath("\\\\Server\\Share\\Repo\\.ade\\artifacts\\x.mp4", "\\\\server\\share\\repo", "linux"))
      .toBe(".ade/artifacts/x.mp4");
    expect(projectRelativeArtifactPath("file:///C:/Repo/.ade/artifacts/x.mp4", "c:\\repo", "linux"))
      .toBe(".ade/artifacts/x.mp4");
    // POSIX roots fold on macOS and stay exact on Linux.
    expect(projectRelativeArtifactPath("/users/me/REPO/.ade/artifacts/x.mp4", root, "darwin"))
      .toBe(".ade/artifacts/x.mp4");
    expect(projectRelativeArtifactPath("/users/me/REPO/.ade/artifacts/x.mp4", root, "linux")).toBeNull();
    expect(projectRelativeArtifactPath("/Users/me/repo-evil/x.mp4", root, "darwin")).toBeNull();
  });

  it("refuses paths outside the project and any `..`", () => {
    expect(localArtifactStreamUrl("/Users/me/other/.ade/artifacts/x.mp4", root)).toBeNull();
    expect(localArtifactStreamUrl("/Users/me/repo-evil/x.mp4", root)).toBeNull();
    expect(localArtifactStreamUrl(`${root}/.ade/x.mp4`, null)).toBeNull();
    expect(localArtifactStreamUrl("../secrets/x.mp4", root)).toBeNull();
    expect(localArtifactStreamUrl(".ade/artifacts/../../x.mp4", root)).toBeNull();
    expect(localArtifactStreamUrl("ade-artifact://project/.ade/%2E%2E/x.mp4", root)).toBeNull();
    expect(localArtifactStreamUrl("ade-artifact://project/a%2Fb.mp4", root)).toBeNull();
    expect(localArtifactStreamUrl("https://example.com/x.mp4", root)).toBeNull();
    expect(localArtifactStreamUrl("", root)).toBeNull();
    expect(projectRelativeArtifactPath(`${root}/`, root)).toBeNull();
  });

  it("builds media server URLs for videos here and on a paired machine, and parses them back", () => {
    const local = localArtifactMediaUrl(`${BASE}/`, `${root}/.ade/artifacts/a b#1.mp4`, root);
    expect(local).toBe(`${BASE}/project/.ade/artifacts/a%20b%231.mp4`);
    expect(parseArtifactMediaPath(afterBase(local))).toEqual({
      kind: "project",
      relativePath: ".ade/artifacts/a b#1.mp4",
    });
    expect(localArtifactMediaUrl(BASE, "../x.mp4", root)).toBeNull();
    expect(localArtifactMediaUrl("", ".ade/artifacts/x.mp4", root)).toBeNull();

    const remote = remoteArtifactMediaUrl(BASE, {
      uri: "/remote/repo/.ade/artifacts/rec 1.mov",
      targetId: "target/1",
      projectId: "project-1",
      remoteProjectRoot: "/remote/repo",
    });
    expect(remote).toBe(`${BASE}/remote/target%2F1/project-1/.ade/artifacts/rec%201.mov`);
    expect(parseArtifactMediaPath(afterBase(remote))).toEqual({
      kind: "remote",
      targetId: "target/1",
      projectId: "project-1",
      relativePath: ".ade/artifacts/rec 1.mov",
    });
    expect(remoteArtifactMediaUrl(BASE, { uri: "/elsewhere/x.mp4", targetId: "t", projectId: "p", remoteProjectRoot: "/remote/repo" }))
      .toBeNull();
  });

  it("refuses a media path that walks out of the project instead of folding it", () => {
    expect(parseArtifactMediaPath("project/.ade/../../etc/passwd")).toBeNull();
    expect(parseArtifactMediaPath("project/.ade/%2E%2E/x.mp4")).toBeNull();
    expect(parseArtifactMediaPath("project/./x.mp4")).toBeNull();
    expect(parseArtifactMediaPath("project/a%2F..%2Fb.mp4")).toBeNull();
    expect(parseArtifactMediaPath("project/a%5Cb.mp4")).toBeNull();
    expect(parseArtifactMediaPath("project/%E0%A4%A.mp4")).toBeNull();
    expect(parseArtifactMediaPath("project")).toBeNull();
    expect(parseArtifactMediaPath("remote/t/p/.ade/../../etc/passwd")).toBeNull();
    expect(parseArtifactMediaPath("remote/t/p/.ade/%2E%2E/x.mp4")).toBeNull();
    expect(parseArtifactMediaPath("remote/t/p")).toBeNull();
    expect(parseArtifactMediaPath("remote//p/x.mp4")).toBeNull();
    expect(parseArtifactMediaPath("elsewhere/x.mp4")).toBeNull();
    expect(parseArtifactMediaPath("project/x.mp4?t=1")).toEqual({ kind: "project", relativePath: "x.mp4" });
  });
});
