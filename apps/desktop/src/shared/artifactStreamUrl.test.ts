import { describe, expect, it } from "vitest";
import {
  localArtifactStreamUrl,
  parseRemoteArtifactStreamUrl,
  projectRelativeArtifactPath,
  remoteArtifactStreamUrl,
} from "./artifactStreamUrl";

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

  it("round-trips a paired machine's proof through the remote URL", () => {
    const url = remoteArtifactStreamUrl({
      uri: "/remote/repo/.ade/artifacts/rec 1.mov",
      targetId: "target/1",
      projectId: "project-1",
      remoteProjectRoot: "/remote/repo",
    });
    expect(url).toBe("ade-artifact://remote/target%2F1/project-1/.ade/artifacts/rec%201.mov");
    expect(parseRemoteArtifactStreamUrl(url!)).toEqual({
      targetId: "target/1",
      projectId: "project-1",
      relativePath: ".ade/artifacts/rec 1.mov",
    });
    expect(remoteArtifactStreamUrl({ uri: "/elsewhere/x.mp4", targetId: "t", projectId: "p", remoteProjectRoot: "/remote/repo" }))
      .toBeNull();
  });

  it("refuses a remote URL that walks out of the project instead of folding it", () => {
    expect(parseRemoteArtifactStreamUrl("ade-artifact://remote/t/p/.ade/../../etc/passwd")).toBeNull();
    expect(parseRemoteArtifactStreamUrl("ade-artifact://remote/t/p/.ade/%2E%2E/x.mp4")).toBeNull();
    expect(parseRemoteArtifactStreamUrl("ade-artifact://remote/t/p/./x.mp4")).toBeNull();
    expect(parseRemoteArtifactStreamUrl("ade-artifact://remote/t/p/a%2F..%2Fb.mp4")).toBeNull();
    expect(parseRemoteArtifactStreamUrl("ade-artifact://remote/t/p")).toBeNull();
    expect(parseRemoteArtifactStreamUrl("ade-artifact://remote//p/x.mp4")).toBeNull();
    expect(parseRemoteArtifactStreamUrl("ade-artifact://project/x.mp4")).toBeNull();
  });
});
