import { describe, expect, it, vi } from "vitest";

import type { ComputerUseArtifactView } from "../../../shared/types/computerUseArtifacts";
import { findVoiceCallStills, type SceneStillArtifactSource } from "./sceneStills";

/**
 * The views a call drew, read back out of the store it filed them in.
 *
 * The call state used to carry a second copy of every still for the length of
 * the call. It does not any more, so what has to hold is that the read finds
 * exactly this call's pictures on a session that holds every call the project
 * ever had — and that it cannot take a hang-up down with it.
 */

function artifact(over: Partial<ComputerUseArtifactView>): ComputerUseArtifactView {
  return {
    id: "a1",
    kind: "screenshot",
    backendStyle: "manual",
    backendName: "scene",
    sourceToolName: "scene_snapshot",
    originalType: null,
    title: "Generated view",
    description: null,
    uri: ".ade/artifacts/computer-use/a.png",
    storageKind: "file",
    mimeType: "image/png",
    metadata: {},
    createdAt: "2026-09-17T10:00:00.000Z",
    links: [],
    reviewState: "pending",
    workflowState: "evidence_only",
    reviewNote: null,
    ...over,
  };
}

/** The broker answers newest first, which is the order a transcript reverses. */
function brokerOf(rows: ComputerUseArtifactView[]): SceneStillArtifactSource {
  return { listArtifacts: vi.fn(() => rows) };
}

const still = (
  id: string,
  voiceCallId: string | null,
  sceneTitle?: string,
): ComputerUseArtifactView =>
  artifact({
    id,
    uri: `.ade/artifacts/computer-use/${id}.png`,
    metadata: {
      kind: "scene_still",
      sceneScopeKey: voiceCallId ?? "chat",
      ...(voiceCallId ? { voiceCallId } : {}),
      ...(sceneTitle ? { sceneTitle } : {}),
    },
  });

describe("findVoiceCallStills", () => {
  it("keeps this call's stills, in the order they were drawn", () => {
    const broker = brokerOf([
      still("c", "call-1", "PRs"),
      still("b", "call-1", "Lanes"),
      still("a", "call-1", "Today"),
    ]);

    const found = findVoiceCallStills(broker, { sessionId: "session-1", callId: "call-1" });

    expect(found).toEqual([
      { artifactId: "a", uri: ".ade/artifacts/computer-use/a.png", title: "Today" },
      { artifactId: "b", uri: ".ade/artifacts/computer-use/b.png", title: "Lanes" },
      { artifactId: "c", uri: ".ade/artifacts/computer-use/c.png", title: "PRs" },
    ]);
    expect(broker.listArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ ownerKind: "chat_session", ownerId: "session-1" }),
    );
  });

  /**
   * One CTO session holds every call the project ever had, and every ordinary
   * capture besides. The call id is the filter that makes the read this call's.
   */
  it("leaves another call's stills, and every artifact that is not one", () => {
    const found = findVoiceCallStills(
      brokerOf([
        still("mine", "call-1"),
        still("theirs", "call-2"),
        // A scene still from a chat, not a call: no call id on it at all.
        still("chat", null),
        // An ordinary capture that happens to be on the same session.
        artifact({ id: "shot", metadata: { kind: "screenshot" } }),
      ]),
      { sessionId: "session-1", callId: "call-1" },
    );

    expect(found.map((row) => row.artifactId)).toEqual(["mine"]);
  });

  it("falls back to the artifact's own title when the still carried none", () => {
    const found = findVoiceCallStills(
      brokerOf([artifact({
        id: "a",
        title: "Snapshot",
        metadata: { kind: "scene_still", sceneScopeKey: "call-1", voiceCallId: "call-1" },
      })]),
      { sessionId: "session-1", callId: "call-1" },
    );

    expect(found[0]?.title).toBe("Snapshot");
  });

  /**
   * A record without its pictures is a smaller loss than a hang-up that throws,
   * and the broker is optional on the runtime in the first place.
   */
  it("answers nothing rather than failing when there is nobody to ask", () => {
    expect(findVoiceCallStills(null, { sessionId: "session-1", callId: "call-1" })).toEqual([]);
    expect(findVoiceCallStills(brokerOf([still("a", "call-1")]), {
      sessionId: null,
      callId: "call-1",
    })).toEqual([]);
    expect(findVoiceCallStills(brokerOf([still("a", "call-1")]), {
      sessionId: "session-1",
      callId: null,
    })).toEqual([]);
    expect(findVoiceCallStills(
      { listArtifacts: () => { throw new Error("database is locked"); } },
      { sessionId: "session-1", callId: "call-1" },
    )).toEqual([]);
  });
});
