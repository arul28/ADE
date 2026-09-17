import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import { SCENE_STILL_METADATA_KIND } from "../../../shared/types";

type ComputerUseArtifactBroker = NonNullable<AdeRuntime["computerUseArtifactBrokerService"]>;

/**
 * How many stills one chat keeps.
 *
 * A still is a picture, not evidence, so the only question the bound answers is
 * disk: every settled scene writes a PNG of a whole view, and a long chat draws
 * a lot of scenes. Thirty-two is well past what any scrollback shows at once
 * and small enough that the worst case is megabytes rather than gigabytes.
 */
export const SCENE_STILL_MAX_PER_SESSION = 32;

/**
 * How much of a scene's title reaches the NAME ON DISK.
 *
 * A scene titles itself, up to 120 characters of agent-authored text, and the
 * artifact file name is carried by every filesystem this project is ever
 * checked out on — several of which cap a component at 255 bytes before the
 * timestamp and extension the store adds. The record keeps the whole title;
 * the file name is only a label for a human reading a directory listing.
 */
export const SCENE_STILL_FILE_LABEL_MAX = 80;

export function sceneStillFileLabel(title: string): string {
  return title.slice(0, SCENE_STILL_FILE_LABEL_MAX);
}

export type FileSceneStillArgs = {
  broker: ComputerUseArtifactBroker;
  /** Absolute path of the PNG, already inside `.ade/artifacts/computer-use`. */
  path: string;
  title: string;
  /** The chat that owns the picture. Null means nothing prunes it — see below. */
  ownerSessionId: string | null;
  /** Identity of the scene the picture is of: one still per key. */
  sceneScopeKey: string | null;
  /** Set when the scene was drawn on a voice call; the call card reads by it. */
  voiceCallId?: string | null;
};

export type SceneStillFiling = {
  artifactId: string | null;
  /** Artifacts removed to stay inside the two bounds, for tests and logs. */
  removedArtifactIds: string[];
};

/**
 * File a scene still through the broker, then hold the two bounds.
 *
 * The record is the INDEX, not a drawer row: it is tagged
 * `metadata.kind = "scene_still"` so every proof surface excludes it, and it
 * exists so a reopened window can find the bytes again without the renderer
 * keeping its own durable list of artifact uris.
 *
 * Bounds, both enforced here because both are about the same finite disk:
 *  - One still per `sceneScopeKey`. A scene that settles again — a re-render, a
 *    second window, a call that redraws the same view — supersedes its own
 *    picture rather than leaving a trail of them.
 *  - At most {@link SCENE_STILL_MAX_PER_SESSION} per owning chat, oldest first.
 *
 * Both are scoped to the owner, so an unowned still (no chat could be resolved)
 * prunes nothing: there is no set to be the newest member of. That is the same
 * trade the filing itself makes — an unattributed picture beats a lost one.
 */
export function fileSceneStill({
  broker,
  path,
  title,
  ownerSessionId,
  sceneScopeKey,
  voiceCallId,
}: FileSceneStillArgs): SceneStillFiling {
  const scopeKey = typeof sceneScopeKey === "string" ? sceneScopeKey.trim() : "";
  const callId = typeof voiceCallId === "string" ? voiceCallId.trim() : "";
  const filed = broker.ingest({
    backend: { name: "scene", style: "manual", toolName: "scene_still" },
    ...(ownerSessionId ? { owners: [{ kind: "chat_session" as const, id: ownerSessionId }] } : {}),
    inputs: [{
      kind: "screenshot",
      title: title.slice(0, 200),
      path,
      mimeType: "image/png",
      description: "Still of an agent-authored scene, taken when it stopped moving.",
      metadata: {
        kind: SCENE_STILL_METADATA_KIND,
        ...(scopeKey ? { sceneScopeKey: scopeKey } : {}),
        sceneTitle: title.slice(0, 200),
        ...(callId ? { voiceCallId: callId } : {}),
      },
    }],
  });
  const artifactId = filed?.artifacts?.[0]?.id ?? null;
  const removedArtifactIds = ownerSessionId
    ? pruneSceneStills({ broker, ownerSessionId, keepArtifactId: artifactId, scopeKey })
    : [];
  return { artifactId, removedArtifactIds };
}

function pruneSceneStills(args: {
  broker: ComputerUseArtifactBroker;
  ownerSessionId: string;
  keepArtifactId: string | null;
  scopeKey: string;
}): string[] {
  const { broker, ownerSessionId, keepArtifactId, scopeKey } = args;
  // Only this chat's stills, and only stills: the include filter is what keeps
  // a chat with a hundred proof artifacts from returning a page of proof and
  // no stills at all, which would make both bounds silently stop working.
  const existing = broker.listArtifacts({
    ownerKind: "chat_session",
    ownerId: ownerSessionId,
    metadataKinds: [SCENE_STILL_METADATA_KIND],
    limit: 2000,
  });
  const doomed: string[] = [];
  const survivors: typeof existing = [];
  for (const artifact of existing) {
    if (artifact.id === keepArtifactId) {
      survivors.push(artifact);
      continue;
    }
    const metadataScopeKey = typeof artifact.metadata?.sceneScopeKey === "string"
      ? artifact.metadata.sceneScopeKey
      : "";
    if (scopeKey && metadataScopeKey === scopeKey) {
      doomed.push(artifact.id);
      continue;
    }
    survivors.push(artifact);
  }
  // `listArtifacts` answers newest first, so the tail is the oldest.
  if (survivors.length > SCENE_STILL_MAX_PER_SESSION) {
    for (const artifact of survivors.slice(SCENE_STILL_MAX_PER_SESSION)) doomed.push(artifact.id);
  }
  if (!doomed.length) return [];
  // The broker's own removal path: it unlinks the bytes inside the artifact
  // jail as well as dropping the row, which is the whole reason the still is
  // filed through it rather than written and forgotten.
  broker.deleteArtifacts({ artifactIds: doomed });
  return doomed;
}
