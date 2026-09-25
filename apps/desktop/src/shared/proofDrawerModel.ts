/**
 * How the proof drawer organizes a chat's proof: by the turn that filed it,
 * and inside each turn, what the answer showed before everything else.
 *
 * Pure: artifacts and transcript events in, groups out. The desktop drawer
 * renders it; the iOS sheet mirrors the same rules in Swift.
 */

import type { AgentChatEventEnvelope } from "./types/chat";
import type { ComputerUseArtifactView } from "./types/computerUseArtifacts";
import { citedProofArtifactIds, proofCompareBlocks } from "./proofCitation";

export type ProofDrawerItem =
  | { kind: "single"; artifact: ComputerUseArtifactView }
  | {
      kind: "pair";
      before: ComputerUseArtifactView;
      after: ComputerUseArtifactView;
      caption: string | null;
    };

export type ProofDrawerGroup = {
  /** Stable React key. */
  key: string;
  turnId: string | null;
  /** The request that started the turn, when the transcript still holds it. */
  prompt: string | null;
  /** When the turn started, or the oldest item's time for the "earlier" group. */
  at: string;
  /** Proof the turn's answer shows, in the order it shows it. */
  inAnswer: ProofDrawerItem[];
  /** Proof filed in the turn that its answer does not show. */
  other: ProofDrawerItem[];
};

export type ProofDrawerFilter = {
  query: string;
  media: "all" | "pictures" | "videos";
  /** Only proof an answer shows. */
  inAnswerOnly: boolean;
};

export const EMPTY_PROOF_DRAWER_FILTER: ProofDrawerFilter = { query: "", media: "all", inAnswerOnly: false };

type TurnInfo = {
  turnId: string;
  prompt: string | null;
  startedAt: string;
  endedAt: string | null;
  answerText: string;
};

function eventTurnId(event: AgentChatEventEnvelope["event"]): string | null {
  const value = (event as { turnId?: unknown }).turnId;
  return typeof value === "string" && value ? value : null;
}

/** The chat's turns in order, with each one's prompt and joined answer text. */
export function readChatTurns(events: readonly AgentChatEventEnvelope[]): TurnInfo[] {
  const turns: TurnInfo[] = [];
  const byId = new Map<string, TurnInfo>();
  let pendingPrompt: string | null = null;
  for (const envelope of events) {
    const { event } = envelope;
    if (event.type === "user_message") {
      const text = (event.displayText ?? event.text ?? "").trim();
      if (text) pendingPrompt = text;
    }
    const turnId = eventTurnId(event);
    if (!turnId) continue;
    let turn = byId.get(turnId);
    if (!turn) {
      turn = { turnId, prompt: pendingPrompt, startedAt: envelope.timestamp, endedAt: null, answerText: "" };
      pendingPrompt = null;
      byId.set(turnId, turn);
      turns.push(turn);
    }
    // Answer text streams in pieces; joined, a citation split across two
    // pieces is whole again.
    if (event.type === "text") turn.answerText += event.text;
    if (event.type === "done") turn.endedAt = envelope.timestamp;
  }
  return turns;
}

function artifactTurnId(artifact: ComputerUseArtifactView): string | null {
  const value = artifact.metadata?.turnId;
  return typeof value === "string" && value ? value : null;
}

/**
 * The turn an artifact belongs to: the one it was stamped with, else the turn
 * whose time window holds it. Proof filed before `turnId` existed has only a
 * time.
 */
function placeArtifact(artifact: ComputerUseArtifactView, turns: readonly TurnInfo[], byId: ReadonlyMap<string, TurnInfo>): TurnInfo | null {
  const stamped = artifactTurnId(artifact);
  if (stamped) return byId.get(stamped) ?? null;
  const at = Date.parse(artifact.createdAt);
  if (!Number.isFinite(at)) return null;
  let placed: TurnInfo | null = null;
  for (const turn of turns) {
    const start = Date.parse(turn.startedAt);
    if (!Number.isFinite(start) || start > at) break;
    placed = turn;
  }
  return placed;
}

function matchesFilter(artifact: ComputerUseArtifactView, filter: ProofDrawerFilter): boolean {
  if (filter.media !== "all") {
    const video = artifact.kind === "video_recording" || (artifact.mimeType?.startsWith("video/") ?? false);
    const picture = artifact.kind === "screenshot" || (artifact.mimeType?.startsWith("image/") ?? false);
    if (filter.media === "videos" ? !video : !picture) return false;
  }
  const query = filter.query.trim().toLowerCase();
  if (!query) return true;
  return [artifact.title, artifact.description ?? ""].some((text) => text.toLowerCase().includes(query));
}

/**
 * Turns a list of artifacts into drawer items. Two artifacts that a compare
 * block names as before and after become one pair when both are in the list.
 */
function toItems(
  artifacts: ComputerUseArtifactView[],
  pairs: ReadonlyArray<{ before: string; after: string; caption: string | null }>,
): ProofDrawerItem[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const used = new Set<string>();
  const items: ProofDrawerItem[] = [];
  for (const artifact of artifacts) {
    if (used.has(artifact.id)) continue;
    const pair = pairs.find((entry) =>
      (entry.before === artifact.id || entry.after === artifact.id)
      && byId.has(entry.before) && byId.has(entry.after)
      && !used.has(entry.before) && !used.has(entry.after)
      && entry.before !== entry.after);
    if (pair) {
      used.add(pair.before);
      used.add(pair.after);
      items.push({ kind: "pair", before: byId.get(pair.before)!, after: byId.get(pair.after)!, caption: pair.caption });
      continue;
    }
    used.add(artifact.id);
    items.push({ kind: "single", artifact });
  }
  return items;
}

/** Newest turn first; the "earlier" group, for proof no loaded turn holds, last. */
export function buildProofDrawerGroups(
  artifacts: readonly ComputerUseArtifactView[],
  events: readonly AgentChatEventEnvelope[],
  filter: ProofDrawerFilter = EMPTY_PROOF_DRAWER_FILTER,
): ProofDrawerGroup[] {
  const turns = readChatTurns(events);
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
  const citedByTurn = new Map(turns.map((turn) => [turn.turnId, citedProofArtifactIds(turn.answerText)]));
  const citedAnywhere = new Set([...citedByTurn.values()].flat());
  const pairs = turns.flatMap((turn) => proofCompareBlocks(turn.answerText).map((block) => ({
    before: block.before.artifactId,
    after: block.after.artifactId,
    caption: block.caption,
  })));

  const buckets = new Map<string, { turn: TurnInfo | null; artifacts: ComputerUseArtifactView[] }>();
  const sorted = [...artifacts].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const artifact of sorted) {
    if (!matchesFilter(artifact, filter)) continue;
    if (filter.inAnswerOnly && !citedAnywhere.has(artifact.id)) continue;
    const turn = placeArtifact(artifact, turns, turnsById);
    const key = turn ? `turn:${turn.turnId}` : "earlier";
    const bucket = buckets.get(key) ?? { turn, artifacts: [] };
    bucket.artifacts.push(artifact);
    buckets.set(key, bucket);
  }

  const groups: ProofDrawerGroup[] = [];
  for (const [key, bucket] of buckets) {
    // An answer can show proof an earlier turn filed; it still counts as shown.
    const citedHere = bucket.turn ? citedByTurn.get(bucket.turn.turnId) ?? [] : [];
    const order = (id: string) => {
      const index = citedHere.indexOf(id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    const inAnswer = bucket.artifacts
      .filter((artifact) => citedAnywhere.has(artifact.id))
      .sort((left, right) => order(left.id) - order(right.id));
    const other = bucket.artifacts.filter((artifact) => !citedAnywhere.has(artifact.id));
    groups.push({
      key,
      turnId: bucket.turn?.turnId ?? null,
      prompt: bucket.turn?.prompt ?? null,
      at: bucket.turn?.startedAt ?? bucket.artifacts[0]!.createdAt,
      inAnswer: toItems(inAnswer, pairs),
      other: toItems(other, pairs),
    });
  }
  return groups.sort((left, right) => {
    if (left.key === "earlier") return 1;
    if (right.key === "earlier") return -1;
    return right.at.localeCompare(left.at);
  });
}

/** The PR a proof item was published to, from its `github_pr` owner link. */
export function proofArtifactPullRequest(artifact: ComputerUseArtifactView): { url: string; label: string } | null {
  const link = artifact.links?.find((entry) => entry.ownerKind === "github_pr");
  if (!link) return null;
  const url = link.ownerId;
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return { url, label: number ? `PR #${number}` : "PR" };
}
