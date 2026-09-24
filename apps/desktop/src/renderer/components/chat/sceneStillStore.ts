import { useEffect, useState, useSyncExternalStore } from "react";

import type { SceneStillRecord } from "../../../shared/chatScene";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { SCENE_STILL_METADATA_KIND } from "../../../shared/types";
import { artifactImageSrc } from "../../../shared/artifactStreamUrl";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * Where a scene's picture lives once the scene itself has stopped.
 *
 * A scene is code, and the whole point of freezing one is that the code never
 * runs again. That leaves a question this store answers: what does the user see
 * when they come back? Three moments need an answer and they need the same one
 * — scrolling back to a settled turn, remounting a row the virtualizer threw
 * away, and reopening the chat in a new window — so there is one index rather
 * than a cache per surface.
 *
 * THIS MODULE IS A CACHE, NOT THE INDEX. The index is the artifact broker: main
 * files every still as an artifact tagged `metadata.kind = "scene_still"`,
 * carrying the scene's scope key and, for a scene drawn on a call, the call id.
 * Durable renderer state duplicating that was a second source of truth which
 * could not be pruned with the bytes, went stale the moment main deleted one,
 * and was scoped to a window rather than to a project. So a reopened window
 * asks the broker once per chat and fills these maps from the answer; the maps
 * themselves live and die with the window.
 *
 * Keyed by the caller's `scopeKey` — the per-block scene key for a transcript
 * row, or the call id for a scene drawn on a call. That key is what makes two
 * byte-identical scenes at different positions keep their own picture, and it
 * is stable across a reopen because it is stored with the artifact.
 */

export type SceneStill = {
  /** PNG data URL, present only in the window that took the capture. */
  dataUrl: string | null;
  /** The bytes on disk, once main has stored them. Survives a reopen. */
  record: SceneStillRecord | null;
};

const stills = new Map<string, SceneStill>();
/**
 * The stills a voice call left behind, oldest first.
 *
 * Call scope is its own map rather than a second lookup over the scene one: a
 * call draws several scenes over its length and the card wants all of them,
 * while a transcript row wants exactly the one it drew.
 */
const callStills = new Map<string, SceneStillRecord[]>();

/**
 * One listener set per map. A settling scene notifies every subscriber, and a
 * transcript showing a long call's card re-rendered each of its tiles on every
 * unrelated still in the chat.
 */
const sceneListeners = new Set<() => void>();
const callListeners = new Set<() => void>();

function notifyScenes(): void {
  sceneListeners.forEach((listener) => listener());
}

function notifyCalls(): void {
  callListeners.forEach((listener) => listener());
}

/** Remember a still. The data URL is this window's; the record is durable. */
export function rememberSceneStill(
  scopeKey: string,
  still: { dataUrl?: string | null; record?: SceneStillRecord | null },
): void {
  if (!scopeKey) return;
  const previous = stills.get(scopeKey) ?? { dataUrl: null, record: null };
  const next: SceneStill = {
    dataUrl: still.dataUrl ?? previous.dataUrl,
    record: still.record ?? previous.record,
  };
  stills.set(scopeKey, next);
  notifyScenes();
}

/**
 * The still for a scene, or null.
 *
 * Reads the map and nothing else — no parsing, no lazy fill — because this is
 * a `useSyncExternalStore` snapshot: it runs on every render of every scene row
 * and must return the same object until something actually changed.
 */
export function readSceneStill(scopeKey: string | null | undefined): SceneStill | null {
  if (!scopeKey) return null;
  return stills.get(scopeKey) ?? null;
}

export function rememberCallStill(callId: string, record: SceneStillRecord): void {
  if (!callId || !record?.uri) return;
  const existing = callStills.get(callId) ?? [];
  // A call redraws the same scene as it talks, and each redraw settles into its
  // own still; the same uri twice is the same picture and is dropped.
  if (existing.some((entry) => entry.uri === record.uri)) return;
  callStills.set(callId, [...existing, record]);
  notifyCalls();
}

const NO_STILLS: SceneStillRecord[] = [];

export function readCallStills(callId: string | null | undefined): SceneStillRecord[] {
  if (!callId) return NO_STILLS;
  return callStills.get(callId) ?? NO_STILLS;
}

/* ───────────────────────── the broker-backed index ───────────────────────── */

/** Chats whose stills have been asked for. Value is the in-flight or done read. */
const sessionReads = new Map<string, Promise<void>>();
/** Chats whose read has finished — answered, failed, or had nothing to ask. */
const settledSessions = new Set<string>();

/**
 * True once this chat's stills are known, so a caller can tell "no still" from
 * "not asked yet".
 *
 * `SceneFrame` is why this exists: a settled row must decide whether to run the
 * scene's code or show its picture, and deciding "run it" while the answer was
 * still in flight would re-execute a generated view on every reopen — the one
 * thing the still exists to prevent. A chat with no id has nothing to wait for.
 */
export function useSessionStillsReady(sessionId: string | null | undefined): boolean {
  const owner = typeof sessionId === "string" ? sessionId.trim() : "";
  const read = () => !owner || settledSessions.has(owner);
  return useSyncExternalStore(subscribeScenes, read, read);
}

function readStringField(metadata: Record<string, unknown> | undefined, field: string): string {
  const value = metadata?.[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Ask the broker for one chat's stills, once, and fill the maps above.
 *
 * Once per chat per window: the artifacts change only when this window takes a
 * new still, and that path writes into the maps directly. A failed read is
 * cached as "asked" too — a chat whose machine is unreachable must not have
 * every scene row retry against it on every render.
 */
async function loadSessionStills(
  sessionId: string | null | undefined,
  pin: OpenProjectBinding | null,
): Promise<void> {
  const owner = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!owner) return;
  const inFlight = sessionReads.get(owner);
  if (inFlight) return inFlight;
  const read = (async () => {
    const list = window.ade?.computerUse?.listArtifacts;
    if (typeof list !== "function") return;

    const artifacts = await list(
      {
        ownerKind: "chat_session",
        ownerId: owner,
        // Only stills: a chat with a page of proof would otherwise return
        // proof and no pictures, and every scene row would render empty.
        metadataKind: SCENE_STILL_METADATA_KIND,
        limit: 200,
      },
      pin,
    ).catch(() => []);
    // Newest first from the broker; a call's tiles read oldest first.
    for (const artifact of [...artifacts].reverse()) {
      const uri = typeof artifact?.uri === "string" ? artifact.uri.trim() : "";
      if (!uri) continue;
      const record: SceneStillRecord = {
        uri,
        artifactId: typeof artifact.id === "string" ? artifact.id : null,
        title: readStringField(artifact.metadata, "sceneTitle") || artifact.title || "Generated view",
      };
      const scopeKey = readStringField(artifact.metadata, "sceneScopeKey");
      // Never over a still this window took: that one has a data URL, which is
      // the only picture available with no round trip at all.
      if (scopeKey && !stills.get(scopeKey)) stills.set(scopeKey, { dataUrl: null, record });
      const voiceCallId = readStringField(artifact.metadata, "voiceCallId");
      if (voiceCallId) rememberCallStill(voiceCallId, record);
    }
  })().finally(() => {
    settledSessions.add(owner);
    notifyScenes();
    notifyCalls();
  });
  sessionReads.set(owner, read);
  return read;
}

function subscribeScenes(listener: () => void): () => void {
  sceneListeners.add(listener);
  return () => { sceneListeners.delete(listener); };
}

function subscribeCalls(listener: () => void): () => void {
  callListeners.add(listener);
  return () => { callListeners.delete(listener); };
}

/**
 * The still this scene left behind, from this window or from the broker.
 *
 * The read is fired as an effect rather than during render because it is a
 * round trip, and it is per chat rather than per scene because one query
 * answers every row in the transcript.
 */
export function useSceneStillRecord(
  sessionId: string | null | undefined,
  scopeKey: string | null | undefined,
): SceneStill | null {
  const { pin } = useChatRuntimeScope();
  useEffect(() => {
    if (!scopeKey) return;
    void loadSessionStills(sessionId, pin);
  }, [sessionId, pin, scopeKey]);
  return useSyncExternalStore(
    subscribeScenes,
    () => readSceneStill(scopeKey),
    () => readSceneStill(scopeKey),
  );
}

/** Re-render when a call's stills arrive — the card mounts before they do. */
export function useCallStills(
  sessionId: string | null | undefined,
  callId: string | null | undefined,
): SceneStillRecord[] {
  const { pin } = useChatRuntimeScope();
  useEffect(() => {
    if (!callId) return;
    void loadSessionStills(sessionId, pin);
  }, [sessionId, pin, callId]);
  return useSyncExternalStore(
    subscribeCalls,
    () => readCallStills(callId),
    () => readCallStills(callId),
  );
}

/**
 * Where a still's bytes can be shown from, without a round trip.
 *
 * Exported for its tests: the uri arithmetic is the part of this worth pinning
 * on its own, and it is not otherwise reachable from outside this module.
 *
 * The data URL if the caller has one — it is already in memory — then the
 * artifact uri, which only resolves through the `ade-artifact://` protocol in a
 * LOCAL desktop window. A chat on another machine has no such handler and is
 * answered null here; {@link useSceneStillSrc} is what turns that case into a
 * real picture.
 *
 * The data URL is an argument rather than a field of the first one because the
 * two sources are not the same kind of thing and sniffing a union for `dataUrl`
 * made every caller's intent invisible at the call site.
 */
export function sceneStillSrc(
  record: SceneStillRecord | null | undefined,
  dataUrl?: string | null,
): string | null {
  if (dataUrl) return dataUrl;
  return artifactImageSrc(record?.uri);
}

/**
 * The picture a still can actually be drawn from, on any machine.
 *
 * Same path the proof drawer's tiles take, for the same reason: `ade-artifact://`
 * is a local-window protocol, so a chat pinned to another machine resolved every
 * still to a URL that could not load and drew a broken tile. Remote chats read
 * the bytes back through the broker on the machine that holds them.
 *
 * The in-memory data URL stays the fast prefix — a scene that just settled in
 * this window shows its own capture with no round trip at all.
 */
export function useSceneStillSrc(still: SceneStill | null | undefined): string | null {
  return useSceneStillPreview(still).src;
}

/** The same picture, plus whether an answer is still on its way. */
export type SceneStillPreview = {
  src: string | null;
  /**
   * True only while a cross-machine read of THIS uri is outstanding.
   *
   * `SceneFrame` is the caller that needs the distinction: "no picture yet"
   * and "no picture at all" are the same `null`, and treating the first as the
   * second re-runs an agent's generated code because a round trip was slow.
   */
  pending: boolean;
};

/**
 * The picture a still can be drawn from, and whether it is still being fetched.
 *
 * The answer is stamped with the uri it answers for, so a still whose record
 * changes does not read the previous one's bytes as its own for a tick.
 */
export function useSceneStillPreview(still: SceneStill | null | undefined): SceneStillPreview {
  const scope = useChatRuntimeScope();
  const dataUrl = still?.dataUrl ?? null;
  const uri = still?.record?.uri?.trim() || "";
  const needsRuntimeRead = !dataUrl && Boolean(uri) && scope.isRemote;
  const [answer, setAnswer] = useState<{ uri: string; src: string | null } | null>(null);

  useEffect(() => {
    if (!needsRuntimeRead) {
      setAnswer(null);
      return;
    }
    let cancelled = false;
    const read = window.ade?.computerUse?.readArtifactPreview;
    // No route is an answer, not a wait: this host cannot read the bytes back
    // at all, so a caller holding a placeholder for one would hold it forever.
    if (typeof read !== "function") {
      setAnswer({ uri, src: null });
      return;
    }
    void read({ uri }, scope.pin)
      .then((value) => {
        if (!cancelled) setAnswer({ uri, src: typeof value === "string" ? value : null });
      })
      // Nothing rather than a broken tile: the caller draws no image at all.
      .catch(() => { if (!cancelled) setAnswer({ uri, src: null }); });
    return () => { cancelled = true; };
  }, [needsRuntimeRead, uri, scope.pin]);

  if (dataUrl) return { src: dataUrl, pending: false };
  if (needsRuntimeRead) {
    const answered = answer?.uri === uri;
    return { src: answered ? answer.src : null, pending: !answered };
  }
  return { src: sceneStillSrc(still?.record ?? null, null), pending: false };
}

/** Test seam: forget everything this window remembers. */
export function resetSceneStillsForTest(): void {
  stills.clear();
  callStills.clear();
  sessionReads.clear();
  // Cleared with the reads it mirrors: "asked" and "answered" are one fact.
  settledSessions.clear();
  notifyScenes();
  notifyCalls();
}
