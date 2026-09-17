import fs from "node:fs";
import nodePath from "node:path";

import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { isPathInside } from "../shared/pathCompare";
import { fileSceneStill } from "./sceneStills";

type ComputerUseArtifactBroker = NonNullable<AdeRuntime["computerUseArtifactBrokerService"]>;
type AgentChatService = AdeRuntime["agentChatService"];

export type IngestSceneSnapshotArgs = {
  projectRoot: string;
  broker: ComputerUseArtifactBroker;
  agentChatService: AgentChatService | null;
  /**
   * The chat a LIVE call is running on, asked by call id.
   *
   * A scene drawn on a call is filed from the voice HUD, which is mounted at
   * the shell of a desktop window and sits outside every chat scope — so the
   * caller often cannot name the owning chat, and when it can it is still a
   * renderer. This is the side that owns the call, so it answers from the call
   * itself. Null for any id that is not the call that is actually up.
   */
  resolveVoiceCallSessionId?: ((callId: string) => string | null) | null;
  args?: {
    path?: unknown;
    title?: unknown;
    sessionId?: unknown;
    /**
     * Present only for a scene STILL — the picture a settled view left behind,
     * which is filed as an index rather than as proof. The desktop sends it on
     * the still path and never on the Proof button's, so this one field is what
     * tells the two apart on a runtime-backed build.
     */
    sceneScopeKey?: unknown;
    voiceCallId?: unknown;
  };
};

/**
 * File a scene snapshot the desktop already wrote into the artifact store.
 *
 * The generic `ingest` is deliberately absent from the artifacts action domain
 * — agents create proof only through the validated RPC tool. This is the one
 * narrow exception and it is CTO-only, because it exists for exactly one
 * caller: the Proof button on a generated view, in a desktop whose project is
 * served by a runtime. In that build `computerUseArtifactBrokerService` and
 * `agentChatService` are both null in the desktop process, so the handler that
 * used to run in-process silently answered false every time and its ownership
 * check never ran at all.
 *
 * Nothing here weakens that check; it moves it to the side that can actually
 * perform it. The path must already be inside this project's computer-use
 * artifact directory (the desktop got it from `createComputerUseArtifactPath`,
 * so a caller naming anything else is not the caller this exists for), and the
 * claimed chat is resolved against this project's own sessions rather than
 * trusted.
 */
export async function ingestSceneSnapshot({
  projectRoot,
  broker,
  agentChatService,
  resolveVoiceCallSessionId,
  args,
}: IngestSceneSnapshotArgs): Promise<{
  filed: boolean;
  ownerSessionId: string | null;
  /**
   * The drawer record the bytes were filed as, for a caller that has to show
   * the image back (a scene still). Null when the broker answered no record —
   * the file is still there, so the picture is not lost with the row.
   */
  artifactId: string | null;
}> {
  const rawPath = typeof args?.path === "string" ? args.path.trim() : "";
  if (!rawPath) throw new Error("path is required.");
  // The PRESENCE of a scope key is what tells a still from the Proof button,
  // so a blank one is not a still with no identity — it is a still that would
  // be filed as evidence. Refused rather than guessed at, which is the same
  // answer the in-process path gives before it writes any bytes at all.
  if (args?.sceneScopeKey !== undefined
    && !(typeof args.sceneScopeKey === "string" && args.sceneScopeKey.trim().length)) {
    throw new Error("A scene still needs a scene scope key.");
  }
  const artifactsRoot = nodePath.resolve(
    nodePath.join(resolveAdeLayout(projectRoot).artifactsDir, "computer-use"),
  );
  const outsideStore = new Error(
    "A scene snapshot must already be inside this project's artifact store.",
  );
  // Lexical check FIRST, before anything touches the filesystem: a path
  // outside the store is refused for being outside it whether or not it
  // exists, so the error cannot be used to probe for files elsewhere.
  if (!isPathInside(nodePath.resolve(rawPath), artifactsRoot)) throw outsideStore;
  // Then again on the REAL path. `resolve` is string arithmetic and knows
  // nothing about symlinks, while the `statSync` and the ingest below both
  // follow them: a link planted under the artifact store passed a
  // string-only jail and filed whatever it pointed at — any file this
  // runtime can read. Resolving first makes the check and the read agree on
  // which file they are talking about. The root is resolved too, or the
  // comparison is between a resolved path and an unresolved one, and on
  // macOS the temp root alone is a symlink.
  let resolved: string;
  let realArtifactsRoot: string;
  try {
    resolved = fs.realpathSync(nodePath.resolve(rawPath));
  } catch {
    // ENOENT, a broken link, a path component that is not a directory: from
    // here they are all the same answer.
    throw new Error("The scene snapshot is missing.");
  }
  try {
    realArtifactsRoot = fs.realpathSync(artifactsRoot);
  } catch {
    // A root that cannot be resolved does not exist, and nothing is inside it.
    throw outsideStore;
  }
  if (!isPathInside(resolved, realArtifactsRoot)) throw outsideStore;
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error("The scene snapshot is missing.");
  const title = (typeof args?.title === "string" ? args.title.trim() : "") || "Generated view";

  // Proof in ADE is chat-scoped. A miss drops the OWNER, never the
  // artifact — an unattributed snapshot is a smaller loss than a
  // misattributed one.
  const claimed = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
  let ownerSessionId: string | null = null;
  if (claimed && agentChatService) {
    const found = await agentChatService.getSessionSummary(claimed).catch(() => null);
    if (found) ownerSessionId = claimed;
  }

  const voiceCallId = typeof args?.voiceCallId === "string" ? args.voiceCallId.trim() : "";
  // Second, and only second: a caller that named a chat this project knows has
  // already been believed. This covers the caller that could not name one —
  // the voice HUD, which draws outside every chat scope — by asking the call.
  if (!ownerSessionId && voiceCallId && resolveVoiceCallSessionId) {
    ownerSessionId = resolveVoiceCallSessionId(voiceCallId);
  }

  const sceneScopeKey = typeof args?.sceneScopeKey === "string" ? args.sceneScopeKey.trim() : "";
  if (sceneScopeKey) {
    // A still, not proof. Same jail, same owner resolution, different record:
    // tagged so the proof drawer excludes it, and bounded so a long chat's
    // pictures cannot grow without limit. The filing rules live in one place
    // rather than being repeated on each side of the runtime split.
    const still = fileSceneStill({
      broker,
      path: resolved,
      title,
      ownerSessionId,
      sceneScopeKey,
      voiceCallId,
    });
    return { filed: true, ownerSessionId, artifactId: still.artifactId };
  }

  const filed = broker.ingest({
    backend: { name: "scene", style: "manual", toolName: "scene_snapshot" },
    ...(ownerSessionId ? { owners: [{ kind: "chat_session" as const, id: ownerSessionId }] } : {}),
    inputs: [{
      kind: "screenshot",
      title: title.slice(0, 200),
      path: resolved,
      mimeType: "image/png",
      description: "Snapshot of an agent-authored scene.",
    }],
  });
  // Read defensively: the broker is injected, and a caller that answers
  // nothing has still filed the bytes. An unknown id costs the caller its
  // drawer link, never the picture.
  return { filed: true, ownerSessionId, artifactId: filed?.artifacts?.[0]?.id ?? null };
}
