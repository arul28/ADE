import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import {
  SCENE_STILL_METADATA_KIND,
  type ComputerUseArtifactMetadataKind,
  type ComputerUseArtifactView,
} from "../../../shared/types/computerUseArtifacts";

/**
 * Scene stills: the picture a generated view leaves behind when it stops.
 *
 * One module because there is one rule set. Filing decides what a still is
 * tagged as and how many may exist; reading is the same query run backwards to
 * answer a finished call's "Views drawn" section. Split across two files the
 * metadata tag was written in one and matched in the other, which is exactly
 * the pair that has to agree.
 *
 * A still is an INDEX, not a drawer row: it is tagged
 * `metadata.kind = "scene_still"` so every proof surface excludes it, and it
 * exists so a reopened window can find the bytes again without the renderer
 * keeping its own durable list of artifact uris.
 */

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
const SCENE_STILL_FILE_LABEL_MAX = 80;

export function sceneStillFileLabel(title: string): string {
  return title.slice(0, SCENE_STILL_FILE_LABEL_MAX);
}

/* ──────────────────── who owns a still, and what names it ──────────────────── */

/**
 * The blank scope key both filing sides refuse.
 *
 * Typed rather than a bare `Error` because the two sides do different things
 * with it: the runtime action lets it out as the RPC's failure, while the
 * desktop handler catches it and answers null — a still with no identity is a
 * no-op button press, not an error to log.
 */
export class SceneStillScopeKeyError extends Error {
  constructor(message = "A scene still needs a scene scope key.") {
    super(message);
    this.name = "SceneStillScopeKeyError";
  }
}

/**
 * The scope key a still must carry, or a {@link SceneStillScopeKeyError}.
 *
 * The PRESENCE of a scope key is what tells a still from the Proof button, so a
 * blank one is not a still with no identity — it is a still that would be filed
 * as evidence. Refused before any bytes are written, on both sides, so neither
 * has to guess what the other did.
 */
export function requireSceneStillScopeKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) throw new SceneStillScopeKeyError();
  return key;
}

/** Just enough of the chat service to check that a claimed chat exists here. */
export type SceneStillChatService = {
  getSessionSummary: (sessionId: string) => Promise<unknown>;
} | null | undefined;

export type ResolveSceneStillOwnerArgs = {
  agentChatService: SceneStillChatService;
  /** The chat the RENDERER named. A claim, checked here, never trusted. */
  claimedSessionId: unknown;
  /**
   * The call a scene was drawn on, when it was drawn on one. Omit for the
   * Proof button, which has no call and must not resolve an owner from one.
   */
  voiceCallId?: string | null;
  /** Answers only for the call that is actually up; see below. */
  resolveVoiceCallSessionId?: ((callId: string) => string | null) | null;
};

/**
 * The chat a scene snapshot may be filed against.
 *
 * One function because the desktop handler and the runtime action must agree:
 * proof in ADE is chat-scoped, and a still filed with the wrong owner is filed
 * into someone else's drawer while a still filed with none skips both disk
 * bounds and empties the finished call's "Views drawn" section.
 *
 * Two sources, in order. The renderer's claim first, resolved against THIS
 * project's own sessions — `getSessionSummary` rather than a listing, because
 * the CTO's own thread is an identity session that every default filter hides,
 * and because listing every chat to validate one id reads hundreds of files.
 * Then, only for a claim that did not resolve, the call itself: the voice HUD
 * is mounted at the shell outside every chat scope, so it often cannot name a
 * chat at all, and this side owns the call.
 *
 * A miss drops the OWNER, never the artifact — an unattributed picture is a
 * smaller loss than a misattributed one.
 *
 * NAMING THE LIVE CALL IS ALL A RENDERER CAN DO WITH THIS, AND THAT IS BY
 * DESIGN. `resolveVoiceCallSessionId` answers for the call that is actually up
 * and for nothing else, so the only owner a renderer can reach through it is
 * the CTO thread that call is already running on — a chat the same handler
 * would let it file proof against by claiming it outright. There is no wider
 * reach to close here, so there is no check beyond the live-call one.
 */
export async function resolveSceneStillOwner({
  agentChatService,
  claimedSessionId,
  voiceCallId,
  resolveVoiceCallSessionId,
}: ResolveSceneStillOwnerArgs): Promise<string | null> {
  const claimed = typeof claimedSessionId === "string" ? claimedSessionId.trim() : "";
  if (claimed && agentChatService) {
    const found = await agentChatService.getSessionSummary(claimed).catch(() => null);
    if (found) return claimed;
  }
  const callId = typeof voiceCallId === "string" ? voiceCallId.trim() : "";
  if (callId && resolveVoiceCallSessionId) return resolveVoiceCallSessionId(callId) ?? null;
  return null;
}

/* ─────────────────────────────── filing them ─────────────────────────────── */

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
    metadataKind: SCENE_STILL_METADATA_KIND,
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

/* ─────────────────────────── reading them back ─────────────────────────── */

/** Everything a call record needs to name one still. */
export type VoiceCallStill = {
  artifactId: string;
  uri: string;
  title: string;
};

/** The one broker method this needs, so a test can answer with four fields. */
export type SceneStillArtifactSource = {
  listArtifacts: (args: {
    ownerKind?: "chat_session";
    ownerId?: string | null;
    metadataKind?: ComputerUseArtifactMetadataKind | null;
    limit?: number;
  }) => ComputerUseArtifactView[];
};

/**
 * How many of a session's STILLS are scanned for one call's.
 *
 * The broker orders newest first and a call's own stills are always among the
 * newest on its session, so a window rather than every still the CTO thread
 * has ever produced.
 */
const SCENE_STILL_SCAN_LIMIT = 200;

export function findVoiceCallStills(
  broker: SceneStillArtifactSource | null | undefined,
  { sessionId, callId }: { sessionId: string | null; callId: string | null },
): VoiceCallStill[] {
  // Null-safe by design: `computerUseArtifactBrokerService` is optional on the
  // runtime, and a call that could not resolve its session has no owner to ask
  // about. Neither is a reason to fail a hang-up — the record is written either
  // way, just without a "Views drawn" section.
  if (!broker || !sessionId || !callId) return [];
  let rows: ComputerUseArtifactView[];
  try {
    rows = broker.listArtifacts({
      ownerKind: "chat_session",
      ownerId: sessionId,
      // Filtered by the QUERY, not afterwards: a CTO thread with a page of
      // ordinary proof filled the scan window with it and the call's own
      // pictures fell off the end, so "Views drawn" came back empty on exactly
      // the sessions that had been busiest.
      metadataKind: SCENE_STILL_METADATA_KIND,
      limit: SCENE_STILL_SCAN_LIMIT,
    });
  } catch {
    // The store is a database on disk, and a call record without its pictures
    // is a smaller loss than a hang-up that throws.
    return [];
  }
  return rows
    .filter((row) => row.metadata?.voiceCallId === callId)
    // The broker answers newest first; a transcript reads in the order the call
    // drew them.
    .reverse()
    .map((row) => ({
      artifactId: row.id,
      uri: row.uri,
      title: (typeof row.metadata?.sceneTitle === "string" && row.metadata.sceneTitle.trim())
        || row.title
        || "Generated view",
    }));
}
