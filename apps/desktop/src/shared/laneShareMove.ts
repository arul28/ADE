import type { LaneShareRights } from "./laneShareRights";

/**
 * Moving a chat, with its lane's work, to a machine of the OTHER person of a
 * lane share (plan Part C). Shared by the host (ade-cli), the guest client
 * (renderer) and the machine that receives the work.
 *
 * Trust rules, each enforced where it is written:
 * - Nothing moves before the person who receives the work presses Accept.
 *   The consent lives on the machine that must consent, refuses by default,
 *   expires after 15 minutes, is used once, and is cancelled by a revoke, a
 *   leave or the end of the share (`createLaneShareMoveConsents`).
 * - The work travels as a git bundle of unpushed work (50 MiB at most), in
 *   chunks over the guest connection, and lands only in a NEW lane.
 * - No sign-in, token, credential, provider session or secret moves. The
 *   chat arrives as a text brief (`LaneShareMovePayload`): a fixed list of
 *   fields, and the receiver refuses any other field
 *   (`parseLaneShareMovePayload`).
 * - Names from the other side (lane, branch, title) are checked here and
 *   again on the receiving machine; paths are always made locally.
 */

/** A move waits this long for the other person's answer, then it is gone. */
export const LANE_SHARE_MOVE_TTL_MS = 15 * 60_000;
/** The raw bundle cap; the same as the handoff bundle (`HANDOFF_GIT_BUNDLE_MAX_BYTES`). */
export const LANE_SHARE_MOVE_MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
/** Raw bytes per chunk: its base64 fits one sync frame (720 KiB) with room for the envelope. */
export const LANE_SHARE_MOVE_CHUNK_BYTES = 384 * 1024;
export const LANE_SHARE_MOVE_MAX_CHUNKS = Math.ceil(LANE_SHARE_MOVE_MAX_BUNDLE_BYTES / LANE_SHARE_MOVE_CHUNK_BYTES);
/** Used move ids a consent store keeps, so the same id sent twice is refused. */
const USED_MOVE_IDS_KEPT = 256;

export const LANE_SHARE_MOVE_WAITING_MESSAGE = "A move is already waiting.";
export const LANE_SHARE_MOVE_EXPIRED_MESSAGE = "This move expired. Start it again.";
export const LANE_SHARE_MOVE_USED_MESSAGE = "This move was already handled.";
export const LANE_SHARE_MOVE_NO_CONSENT_MESSAGE = "This move was not accepted.";
export const LANE_SHARE_MOVE_TOO_LARGE_MESSAGE = "This lane's changes are too large to move (over 50 MiB). Push the branch, then move again.";

const MOVE_ID = /^lsm_[0-9a-f]{32}$/;
const GRANT_ID = /^ls_[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const REPO_KEY = /^repo:[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~/-]{1,300}$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~/%-]{1,400}$/;

export type LaneShareMoveDirection = "to_guest" | "to_owner";

/**
 * Where a move is. `offered`: waiting for the other person. `accepted`: they
 * pressed Accept. `packing`: the source builds the bundle and the brief.
 * `ready`: the bundle can be read in chunks. `landing`: the receiver makes
 * the lane and the chat. The last five are final.
 */
export type LaneShareMoveStage =
  | "offered"
  | "accepted"
  | "packing"
  | "ready"
  | "landing"
  | "done"
  | "declined"
  | "expired"
  | "cancelled"
  | "failed";

export const LANE_SHARE_MOVE_FINAL_STAGES: ReadonlySet<LaneShareMoveStage> = new Set(["done", "declined", "expired", "cancelled", "failed"]);

export function newLaneShareMoveId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `lsm_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function isLaneShareMoveId(value: unknown): value is string {
  return typeof value === "string" && MOVE_ID.test(value);
}

export function isLaneShareMoveSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** The bundle as the two sides describe it. The bytes travel in chunks. */
export type LaneShareMoveBundleInfo = {
  bytes: number;
  /** SHA-256 of the raw bundle, lowercase hex. */
  sha256: string;
  chunkCount: number;
  branchHeadSha: string;
  /** The snapshot commit of uncommitted work on top of the tip; null when the tree was clean. */
  snapshotSha: string | null;
  unpushedCommitCount: number;
  changedFileCount: number;
};

/**
 * What the receiving machine gets of the chat. A fixed list of fields:
 * text written for a person, git facts, and a model id as a hint. No route,
 * account, instance, preset, credential id, env, MCP config, provider
 * session id, machine key, session id or file path of the source.
 */
export type LaneShareMovePayload = {
  version: 1;
  moveId: string;
  title: string | null;
  laneName: string;
  branchName: string;
  headSha: string;
  /** `accountRepoScopeKey(origin)` of the source. */
  repoKey: string;
  /** The model the chat used, as a hint. The receiver uses it only when its own sign-ins offer it. */
  modelHint: string | null;
  brief: string;
  continuationPrompt: string;
  artifacts: { fileChanges: string[]; commands: string[]; errors: string[] };
  linearIssues: Array<{ identifier: string; title: string; url: string | null }>;
  bundle: LaneShareMoveBundleInfo | null;
};

/** The fields of a payload, and nothing else; the receiver refuses any other key. */
export const LANE_SHARE_MOVE_PAYLOAD_KEYS: readonly (keyof LaneShareMovePayload)[] = Object.freeze([
  "version",
  "moveId",
  "title",
  "laneName",
  "branchName",
  "headSha",
  "repoKey",
  "modelHint",
  "brief",
  "continuationPrompt",
  "artifacts",
  "linearIssues",
  "bundle",
]);

const BUNDLE_KEYS = ["bytes", "sha256", "chunkCount", "branchHeadSha", "snapshotSha", "unpushedCommitCount", "changedFileCount"] as const;
const ARTIFACT_KEYS = ["fileChanges", "commands", "errors"] as const;
const ISSUE_KEYS = ["identifier", "title", "url"] as const;

/** The view of a move that each side shows (owner list, guest state). */
export type LaneShareMoveView = {
  moveId: string;
  grantId: string;
  /** The shared lane on the host. */
  laneId: string;
  direction: LaneShareMoveDirection;
  stage: LaneShareMoveStage;
  /** The display name of the person who started it, as the host knows it; null when unknown. */
  starterName: string | null;
  /** `to_guest`: the host chat that moves. `to_owner`: null (the chat is on the guest's machine). */
  sessionId: string | null;
  chatTitle: string | null;
  laneName: string | null;
  branchName: string | null;
  expiresAt: number;
  /** Present from `ready`: what the receiver will read in chunks. */
  bundle: Pick<LaneShareMoveBundleInfo, "bytes" | "sha256" | "chunkCount"> | null;
  /** The share back the receiver makes, by default: the rights of this share. */
  rights: LaneShareRights | null;
  /**
   * `to_guest` only: the owner's account email, so the guest's machine can
   * share the new lane back to the owner through the normal create path.
   * The owner gives it by starting the move.
   */
  shareBackEmail: string | null;
  /** `to_guest` only: the model the chat used; the guest's machine uses it only when its own sign-ins offer it. */
  modelHint: string | null;
  error: string | null;
  result: { laneName: string | null; shareBackGrantId: string | null } | null;
};

// ---------------------------------------------------------------------------
// Names from the other side

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** One line of display text: no control or bidi characters, collapsed spaces, cut. */
export function cleanLaneShareMoveText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return [...text].slice(0, max).join("");
}

/** A lane name for the new lane: plain text, 1..80 characters. The folder is made locally from it. */
export function cleanLaneShareMoveLaneName(value: unknown): string | null {
  return cleanLaneShareMoveText(value, 80);
}

/**
 * A branch name git would accept (a subset of `git check-ref-format
 * --branch`): ASCII letters, digits, `._/-`; no `..`, `//`, `@{`, leading
 * `-`, `.` or `/`, no component that starts with `.` or ends with `.lock`.
 * The receiving machine also runs git's own check.
 */
export function cleanLaneShareMoveBranchName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^refs\/heads\//, "");
  if (!name || name.length > 200) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return null;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return null;
  if (/^[-./]/.test(name) || /[./]$/.test(name)) return null;
  if (name === "HEAD" || name === "@") return null;
  for (const part of name.split("/")) {
    if (!part || part.startsWith(".") || part.endsWith(".lock")) return null;
  }
  return name;
}

// ---------------------------------------------------------------------------
// The payload

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`The moved ${label} is malformed.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`The moved ${label} carries a field ADE does not accept (${key.slice(0, 40)}).`);
  }
  return record;
}

function textList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error("The moved chat has a malformed list.");
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error("The moved chat has a malformed list.");
    return [...entry.replace(CONTROL, " ")].slice(0, maxChars).join("");
  });
}

function boundedText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw new Error(`The moved chat has no ${label}.`);
  // Newlines stay (the brief is Markdown); other control characters go.
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
  if (text.length > maxChars) throw new Error(`The moved chat's ${label} is too long.`);
  return text;
}

function count(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error("The moved work has an invalid count.");
  }
  return value;
}

export function parseLaneShareMoveBundleInfo(value: unknown): LaneShareMoveBundleInfo {
  const record = exactKeys(value, BUNDLE_KEYS, "work");
  const bytes = count(record.bytes, LANE_SHARE_MOVE_MAX_BUNDLE_BYTES);
  if (bytes <= 0) throw new Error("The moved work is empty.");
  const chunkCount = count(record.chunkCount, LANE_SHARE_MOVE_MAX_CHUNKS);
  if (chunkCount !== Math.ceil(bytes / LANE_SHARE_MOVE_CHUNK_BYTES)) throw new Error("The moved work has an invalid chunk count.");
  if (!isLaneShareMoveSha256(record.sha256)) throw new Error("The moved work has an invalid checksum.");
  if (typeof record.branchHeadSha !== "string" || !SHA.test(record.branchHeadSha)) throw new Error("The moved work names an invalid commit.");
  if (record.snapshotSha !== null && (typeof record.snapshotSha !== "string" || !SHA.test(record.snapshotSha))) {
    throw new Error("The moved work names an invalid snapshot.");
  }
  return {
    bytes,
    sha256: record.sha256,
    chunkCount,
    branchHeadSha: record.branchHeadSha,
    snapshotSha: record.snapshotSha as string | null,
    unpushedCommitCount: count(record.unpushedCommitCount, 10_000_000),
    changedFileCount: count(record.changedFileCount, 10_000_000),
  };
}

/**
 * The payload as it arrives from the other person's machine. Every field is
 * checked, and a key outside `LANE_SHARE_MOVE_PAYLOAD_KEYS` (at any level)
 * refuses the whole payload, so a field that could carry a sign-in cannot
 * ride along unnoticed.
 */
export function parseLaneShareMovePayload(value: unknown, expectedMoveId?: string): LaneShareMovePayload {
  const record = exactKeys(value, LANE_SHARE_MOVE_PAYLOAD_KEYS as readonly string[], "chat");
  if (record.version !== 1) throw new Error("This move comes from a newer ADE. Update ADE on this computer.");
  if (!isLaneShareMoveId(record.moveId) || (expectedMoveId && record.moveId !== expectedMoveId)) {
    throw new Error("The moved chat belongs to another move.");
  }
  const laneName = cleanLaneShareMoveLaneName(record.laneName);
  if (!laneName) throw new Error("The moved chat has no lane name.");
  const branchName = cleanLaneShareMoveBranchName(record.branchName);
  if (!branchName) throw new Error("The moved chat names a branch that git does not accept.");
  if (typeof record.headSha !== "string" || !SHA.test(record.headSha)) throw new Error("The moved chat names an invalid commit.");
  if (typeof record.repoKey !== "string" || !REPO_KEY.test(record.repoKey)) throw new Error("The moved chat names an invalid repository.");
  const modelHint = record.modelHint == null ? null : typeof record.modelHint === "string" && MODEL_ID.test(record.modelHint) ? record.modelHint : null;
  const artifacts = exactKeys(record.artifacts, ARTIFACT_KEYS, "chat");
  if (!Array.isArray(record.linearIssues) || record.linearIssues.length > 12) throw new Error("The moved chat has a malformed issue list.");
  const linearIssues = record.linearIssues.map((entry) => {
    const issue = exactKeys(entry, ISSUE_KEYS, "issue");
    const identifier = cleanLaneShareMoveText(issue.identifier, 100);
    const title = cleanLaneShareMoveText(issue.title, 300);
    if (!identifier || title == null) throw new Error("The moved chat has a malformed issue.");
    const url = typeof issue.url === "string" && HTTPS_URL.test(issue.url) ? issue.url : null;
    return { identifier, title, url };
  });
  const bundle = record.bundle == null ? null : parseLaneShareMoveBundleInfo(record.bundle);
  if (bundle && bundle.branchHeadSha !== record.headSha) throw new Error("The moved work does not end at the moved commit.");
  return {
    version: 1,
    moveId: record.moveId,
    title: record.title == null ? null : cleanLaneShareMoveText(record.title, 300),
    laneName,
    branchName,
    headSha: record.headSha,
    repoKey: record.repoKey,
    modelHint,
    brief: boundedText(record.brief, 16_000, "brief"),
    continuationPrompt: boundedText(record.continuationPrompt, 4_000, "note"),
    artifacts: {
      fileChanges: textList(artifacts.fileChanges, 200, 1_000),
      commands: textList(artifacts.commands, 200, 1_000),
      errors: textList(artifacts.errors, 200, 1_000),
    },
    linearIssues,
    bundle,
  };
}

/**
 * Builds the payload from a prepared handoff capsule by copying only the
 * listed fields. Everything else of the capsule stays on the source:
 * `route` (the sign-in route), `target` (permission modes and provider
 * settings), `origin`/`returnTo` (machine keys and session ids),
 * `scheduledWork` (prompts that would run later with the receiver's
 * sign-ins), `source.machineName`/`machineKey`/`sessionId`/`provider`,
 * `forkTransport` (provider-native session files) and `transcriptEnvelopes`.
 */
export function laneShareMovePayloadFromCapsule(
  capsule: {
    source: { title: string | null; laneName: string; branchRef: string; headSha: string; model: string };
    target: { targetModelId: string };
    brief: string;
    continuationPrompt: string;
    artifacts: { fileChanges: string[]; commands: string[]; errors: string[] };
    linearIssues: Array<{ identifier: string; title: string; url: string | null }>;
  },
  extra: { moveId: string; repoKey: string; bundle: LaneShareMoveBundleInfo | null },
): LaneShareMovePayload {
  const payload = {
    version: 1 as const,
    moveId: extra.moveId,
    title: capsule.source.title,
    laneName: capsule.source.laneName,
    branchName: capsule.source.branchRef.replace(/^refs\/heads\//, ""),
    headSha: capsule.source.headSha,
    repoKey: extra.repoKey,
    modelHint: capsule.target.targetModelId || null,
    brief: capsule.brief,
    continuationPrompt: capsule.continuationPrompt,
    artifacts: {
      fileChanges: capsule.artifacts.fileChanges.slice(0, 200),
      commands: capsule.artifacts.commands.slice(0, 200),
      errors: capsule.artifacts.errors.slice(0, 200),
    },
    linearIssues: capsule.linearIssues.slice(0, 12).map((issue) => ({ identifier: issue.identifier, title: issue.title, url: issue.url })),
    bundle: extra.bundle,
  };
  // The source checks its own payload the way the receiver will.
  return parseLaneShareMovePayload(payload, extra.moveId);
}

// ---------------------------------------------------------------------------
// Consent

export type LaneShareMoveConsent = {
  moveId: string;
  grantId: string;
  laneId: string;
  direction: LaneShareMoveDirection;
  state: "offered" | "accepted" | "used";
  expiresAt: number;
};

export type LaneShareMoveConsentRefusal = { ok: false; code: string; message: string };

/**
 * Consents on the machine that must consent. Default refuse: a move id that
 * was never offered, was declined, expired or was used reads as no consent.
 * One live move per grant: a second offer while one waits is refused with
 * "A move is already waiting", whichever person started either. A used,
 * declined or cancelled id is remembered, so the same id sent again is
 * refused.
 */
export function createLaneShareMoveConsents(options: { now?: () => number; ttlMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? LANE_SHARE_MOVE_TTL_MS;
  const live = new Map<string, LaneShareMoveConsent>();
  const finished = new Map<string, string>();

  const remember = (moveId: string, why: string): void => {
    finished.delete(moveId);
    finished.set(moveId, why);
    while (finished.size > USED_MOVE_IDS_KEPT) {
      const oldest = finished.keys().next().value;
      if (oldest === undefined) break;
      finished.delete(oldest);
    }
  };

  const sweep = (): string[] => {
    const at = now();
    const expired: string[] = [];
    for (const [moveId, consent] of live) {
      if (consent.state !== "used" && at >= consent.expiresAt) {
        live.delete(moveId);
        remember(moveId, "expired");
        expired.push(moveId);
      }
    }
    return expired;
  };

  const refuse = (code: string, message: string): LaneShareMoveConsentRefusal => ({ ok: false, code, message });

  const current = (moveId: string, grantId: string): LaneShareMoveConsent | LaneShareMoveConsentRefusal => {
    sweep();
    const consent = live.get(moveId);
    if (!consent || consent.grantId !== grantId) {
      const why = finished.get(moveId);
      if (why === "expired") return refuse("lane_share_move_expired", LANE_SHARE_MOVE_EXPIRED_MESSAGE);
      if (why) return refuse("lane_share_move_used", LANE_SHARE_MOVE_USED_MESSAGE);
      return refuse("lane_share_move_no_consent", LANE_SHARE_MOVE_NO_CONSENT_MESSAGE);
    }
    return consent;
  };

  return {
    /** Records an offer that waits for this machine's person. */
    offer(input: { moveId: string; grantId: string; laneId: string; direction: LaneShareMoveDirection; expiresAt?: number }):
      | { ok: true; consent: LaneShareMoveConsent }
      | LaneShareMoveConsentRefusal {
      sweep();
      if (!isLaneShareMoveId(input.moveId) || !GRANT_ID.test(input.grantId)) return refuse("invalid_args", "That move is not valid.");
      if (live.has(input.moveId) || finished.has(input.moveId)) return refuse("lane_share_move_used", LANE_SHARE_MOVE_USED_MESSAGE);
      for (const consent of live.values()) {
        if (consent.grantId === input.grantId && consent.state !== "used") {
          return refuse("lane_share_move_waiting", LANE_SHARE_MOVE_WAITING_MESSAGE);
        }
      }
      const at = now();
      const expiresAt = Math.min(input.expiresAt ?? at + ttlMs, at + ttlMs);
      if (expiresAt <= at) return refuse("lane_share_move_expired", LANE_SHARE_MOVE_EXPIRED_MESSAGE);
      const consent: LaneShareMoveConsent = { ...input, state: "offered", expiresAt };
      live.set(input.moveId, consent);
      return { ok: true, consent };
    },
    /** The person pressed Accept. Only an offered, unexpired move of this grant. */
    accept(moveId: string, grantId: string): { ok: true; consent: LaneShareMoveConsent } | LaneShareMoveConsentRefusal {
      const consent = current(moveId, grantId);
      if ("ok" in consent) return consent;
      if (consent.state !== "offered") return refuse("lane_share_move_used", LANE_SHARE_MOVE_USED_MESSAGE);
      consent.state = "accepted";
      return { ok: true, consent };
    },
    /** True only for an accepted, unexpired, unused consent of this grant and lane. */
    isAccepted(moveId: string, grantId: string, laneId?: string): boolean {
      const consent = current(moveId, grantId);
      if ("ok" in consent) return false;
      return consent.state === "accepted" && (laneId === undefined || consent.laneId === laneId);
    },
    /**
     * Uses the consent: the one moment the work may land. True once; every
     * later call (the same id sent twice) is refused.
     */
    consume(moveId: string, grantId: string): { ok: true } | LaneShareMoveConsentRefusal {
      const consent = current(moveId, grantId);
      if ("ok" in consent) return consent;
      if (consent.state !== "accepted") {
        return consent.state === "used"
          ? refuse("lane_share_move_used", LANE_SHARE_MOVE_USED_MESSAGE)
          : refuse("lane_share_move_no_consent", LANE_SHARE_MOVE_NO_CONSENT_MESSAGE);
      }
      consent.state = "used";
      return { ok: true };
    },
    /** The move ended (done, declined, failed, cancelled): its id is never accepted again. */
    finish(moveId: string, why = "finished"): boolean {
      const had = live.delete(moveId);
      remember(moveId, why);
      return had;
    },
    /** A revoke, a leave or the end of the share: every move of the grant ends. */
    cancelGrant(grantId: string): string[] {
      const cancelled: string[] = [];
      for (const [moveId, consent] of live) {
        if (consent.grantId !== grantId) continue;
        live.delete(moveId);
        remember(moveId, "cancelled");
        cancelled.push(moveId);
      }
      return cancelled;
    },
    get(moveId: string): LaneShareMoveConsent | null {
      sweep();
      return live.get(moveId) ?? null;
    },
    /** Ids that expired since the last call (for clean-up). */
    sweep,
  };
}

export type LaneShareMoveConsents = ReturnType<typeof createLaneShareMoveConsents>;

// ---------------------------------------------------------------------------
// Chunks

/** Strict base64 of one chunk: the declared index, the right size, nothing past the declared total. */
export function laneShareMoveChunkSize(bundleBytes: number, index: number): number {
  const chunkCount = Math.ceil(bundleBytes / LANE_SHARE_MOVE_CHUNK_BYTES);
  if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount) return -1;
  return index === chunkCount - 1 ? bundleBytes - index * LANE_SHARE_MOVE_CHUNK_BYTES : LANE_SHARE_MOVE_CHUNK_BYTES;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `data` is base64 of exactly `size` bytes (no whitespace, canonical padding). */
export function laneShareMoveChunkLooksRight(data: unknown, size: number): data is string {
  if (typeof data !== "string" || size <= 0 || !BASE64.test(data)) return false;
  return data.length === Math.ceil(size / 3) * 4;
}
