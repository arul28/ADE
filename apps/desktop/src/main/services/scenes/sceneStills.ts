import {
  SCENE_STILL_METADATA_KIND,
  type ComputerUseArtifactView,
} from "../../../shared/types/computerUseArtifacts";

/**
 * The stills one voice call drew, read back out of the artifact store.
 *
 * A call's durable record names the views it drew by artifact path, because "I
 * drew them a chart" is only useful if the chart can still be found. The bytes
 * and the index that resolves them already belong to the broker — the renderer
 * files every still through it as it settles — so the call reads them back at
 * hang-up rather than being handed a second copy of the same records over IPC
 * and carrying them for the length of the call.
 *
 * Proof in ADE is chat-scoped, so the query is by owner and the call id is a
 * filter on top: one CTO session holds every call this project ever had.
 */

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
    limit?: number;
  }) => ComputerUseArtifactView[];
};

/**
 * How many of a session's artifacts are scanned for one call's stills.
 *
 * The broker orders newest first and a call's own stills are always among the
 * newest on its session, so a window rather than every artifact the CTO thread
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
      limit: SCENE_STILL_SCAN_LIMIT,
    });
  } catch {
    // The store is a database on disk, and a call record without its pictures
    // is a smaller loss than a hang-up that throws.
    return [];
  }
  return rows
    .filter((row) =>
      row.metadata?.kind === SCENE_STILL_METADATA_KIND
      && row.metadata?.voiceCallId === callId)
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
