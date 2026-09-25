import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "./types/chat";
import type { ComputerUseArtifactLink, ComputerUseArtifactView } from "./types/computerUseArtifacts";
import {
  buildProofDrawerGroups,
  EMPTY_PROOF_DRAWER_FILTER,
  proofArtifactPullRequest,
  type ProofDrawerFilter,
} from "./proofDrawerModel";

const at = (minute: number) => `2026-09-25T10:${String(minute).padStart(2, "0")}:00.000Z`;

function envelope(timestamp: string, event: Record<string, unknown>): AgentChatEventEnvelope {
  return { sessionId: "session-1", timestamp, event } as unknown as AgentChatEventEnvelope;
}

function userMessage(turnId: string, text: string, timestamp = at(0)): AgentChatEventEnvelope {
  return envelope(timestamp, { type: "user_message", turnId, displayText: text });
}

function answer(turnId: string, text: string, timestamp = at(1)): AgentChatEventEnvelope {
  return envelope(timestamp, { type: "text", turnId, text });
}

function done(turnId: string, timestamp = at(2)): AgentChatEventEnvelope {
  return envelope(timestamp, { type: "done", turnId });
}

function artifact(index: number, overrides: Partial<ComputerUseArtifactView> = {}): ComputerUseArtifactView {
  return {
    id: `a${index}`,
    kind: "screenshot",
    backendStyle: "local_fallback",
    backendName: "ade-cli",
    sourceToolName: "proof capture",
    originalType: "image",
    title: `Proof ${index}`,
    description: null,
    uri: `.ade/artifacts/proof-${index}.png`,
    storageKind: "file",
    mimeType: "image/png",
    metadata: {},
    createdAt: at(index),
    links: [],
    reviewState: "pending",
    workflowState: "evidence_only",
    reviewNote: null,
    ...overrides,
  };
}

describe("buildProofDrawerGroups", () => {
  it("groups proof by the turn that filed it, newest first, with earlier proof last", () => {
    const events = [
      userMessage("t1", "first request", at(0)),
      answer("t1", "done", at(1)),
      done("t1", at(2)),
      userMessage("t2", "second request", at(10)),
      answer("t2", "done again", at(11)),
      done("t2", at(12)),
    ];
    const ids = (group: { inAnswer: unknown[]; other: unknown[] }) =>
      (group.inAnswer.concat(group.other) as Array<{ kind: string; artifact?: { id: string } }>)
        .map((item) => item.artifact?.id ?? "pair");
    const groups = buildProofDrawerGroups(
      [
        // Stamped t1, even though its time falls inside t2's window: the stamp
        // wins, which is the whole point of saving it.
        artifact(1, { metadata: { turnId: "t1" }, createdAt: at(11) }),
        // No turnId: placed by its time, which falls inside t2's window.
        artifact(2, { createdAt: at(11) }),
        // No turnId and older than every loaded turn: the "earlier" group.
        artifact(3, { createdAt: "2026-09-25T09:00:00.000Z" }),
      ],
      events,
    );

    expect(groups.map((group) => group.key)).toEqual(["turn:t2", "turn:t1", "earlier"]);
    expect(groups[0]!.turnId).toBe("t2");
    expect(groups[0]!.prompt).toBe("second request");
    expect(ids(groups[0]!)).toEqual(["a2"]);
    expect(groups[1]!.turnId).toBe("t1");
    expect(ids(groups[1]!)).toEqual(["a1"]);
    expect(groups[2]!.turnId).toBeNull();
    expect(ids(groups[2]!)).toEqual(["a3"]);
  });

  it("puts what the answer shows before the rest, in citation order, and pairs a compare block", () => {
    const events = [
      userMessage("t1", "compare the two", at(0)),
      answer(
        "t1",
        [
          "![second](ade-proof://a2)",
          "![first](ade-proof://a1)",
          "```proof-compare",
          "before: a3 The old one",
          "after: a4 The new one",
          "caption: seen side by side",
          "```",
        ].join("\n"),
        at(1),
      ),
      done("t1", at(2)),
    ];
    const groups = buildProofDrawerGroups(
      [
        artifact(1, { metadata: { turnId: "t1" }, createdAt: at(1) }),
        artifact(2, { metadata: { turnId: "t1" }, createdAt: at(2) }),
        artifact(3, { metadata: { turnId: "t1" }, createdAt: at(3) }),
        artifact(4, { metadata: { turnId: "t1" }, createdAt: at(4) }),
        artifact(5, { metadata: { turnId: "t1" }, createdAt: at(5) }),
      ],
      events,
    );

    const group = groups[0]!;
    expect(group.inAnswer.map((item) => item.kind === "single" ? item.artifact.id : `pair:${item.before.id}/${item.after.id}`))
      .toEqual(["a2", "a1", "pair:a3/a4"]);
    expect(group.inAnswer[2]).toMatchObject({ kind: "pair", caption: "seen side by side" });
    expect(group.other.map((item) => item.kind === "single" ? item.artifact.id : "pair")).toEqual(["a5"]);
  });

  it("filters by media kind, search text, and whether the answer shows it", () => {
    const events = [userMessage("t1", "checkout", at(0)), answer("t1", "![x](ade-proof://a1)", at(1)), done("t1", at(2))];
    const artifacts = [
      artifact(1, { title: "Login ok", metadata: { turnId: "t1" } }),
      artifact(2, { title: "Checkout flow", kind: "video_recording", mimeType: "video/mp4", metadata: { turnId: "t1" } }),
      artifact(3, { title: "Checkout error", metadata: { turnId: "t1" } }),
    ];
    const only = (filter: Partial<ProofDrawerFilter>) =>
      buildProofDrawerGroups(artifacts, events, { ...EMPTY_PROOF_DRAWER_FILTER, ...filter })
        .flatMap((group) => group.inAnswer.concat(group.other))
        .map((item) => item.kind === "single" ? item.artifact.id : "pair");

    expect(only({ media: "videos" })).toEqual(["a2"]);
    expect(only({ media: "pictures" })).toEqual(["a1", "a3"]);
    expect(only({ query: "login" })).toEqual(["a1"]);
    expect(only({ inAnswerOnly: true })).toEqual(["a1"]);
  });

  it("keeps a compare side that names itself from becoming a pair", () => {
    const events = [
      userMessage("t1", "one picture", at(0)),
      answer("t1", "```proof-compare\nbefore: a1\nafter: a1\n```", at(1)),
      done("t1", at(2)),
    ];
    const groups = buildProofDrawerGroups([artifact(1, { metadata: { turnId: "t1" } })], events);

    expect(groups[0]!.inAnswer).toEqual([{ kind: "single", artifact: expect.objectContaining({ id: "a1" }) }]);
  });
});

function prLink(artifactId: string, ownerId: string): ComputerUseArtifactLink {
  return {
    id: `link-${artifactId}`,
    artifactId,
    ownerKind: "github_pr",
    ownerId,
    relation: "published_to",
    metadata: null,
    createdAt: at(0),
  };
}

describe("proofArtifactPullRequest", () => {
  it("reads the PR chip from a github_pr link and falls back without a number", () => {
    expect(proofArtifactPullRequest(artifact(1, { links: [prLink("a1", "https://github.com/o/r/pull/42")] })))
      .toEqual({ url: "https://github.com/o/r/pull/42", label: "PR #42" });
    expect(proofArtifactPullRequest(artifact(2, { links: [prLink("a2", "https://ghe.example/o/r/pull/7")] }))?.label)
      .toBe("PR #7");
    expect(proofArtifactPullRequest(artifact(3))).toBeNull();
  });
});
