/**
 * Everything the service keeps about what the lane's screen looked like.
 *
 * Observations and their handles, where capture files are written, whether a
 * caller-supplied `out` path is allowed to be written at all, how a captioned
 * capture reaches the proof drawer, and the bookkeeping for the per-turn
 * time-lapse.
 *
 * Kept out of `macDesktopService.ts` because all of it is decidable without a
 * display: a handle either belongs to a retained observation or it does not, a
 * path either stays inside the lane worktree or it does not, and both are worth
 * testing without a window server.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAC_DESKTOP_HANDLE_EXPIRED_CODE,
  MAC_DESKTOP_OBSERVATION_CACHE_SEGMENTS,
  MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE,
  MAC_DESKTOP_PROOF_BACKEND_NAME,
  type MacDesktopElement,
  type MacDesktopObservation,
} from "../../../shared/types/macDesktop";
import type {
  ComputerUseArtifactIngestionRequest,
  ComputerUseArtifactIngestionResult,
  ComputerUseArtifactOwner,
} from "../../../shared/types/computerUseArtifacts";
import {
  createComputerUseArtifactPath,
  createComputerUseScratchPath,
} from "../computerUse/localComputerUse";

/**
 * Where observation frames are written, relative to the project root.
 *
 * Not the computer-use scratch directory: `workToolsStateService` serves a
 * lane-desktop frame to the phone and the hosted web client through
 * `readObservationPreview`, and that reader only accepts paths inside the
 * roots it knows. Writing anywhere else means the mirror silently has no
 * frame, so both sides join the one segment list in the shared contract rather
 * than spelling the path out twice.
 */
export const MAC_DESKTOP_OBSERVATION_CACHE_DIR = path.join(...MAC_DESKTOP_OBSERVATION_CACHE_SEGMENTS);

/** Observations retained per lane. Older handles resolve to "expired". */
export const MAC_DESKTOP_OBSERVATION_RETENTION = 8;

/** Frames the per-turn time-lapse keeps before it stops growing. */
export const MAC_DESKTOP_TIME_LAPSE_MAX_FRAMES = 120;

/** No more than one time-lapse frame a second, whatever the agent is doing. */
export const MAC_DESKTOP_TIME_LAPSE_MIN_FRAME_GAP_MS = 1_000;

export class MacDesktopObservationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    // See `MacDesktopError`: the `CODE: ` prefix is the only part of the code
    // that survives the daemon's flatten-to-message, and it is what the CLI's
    // hint table keys on. The CLI strips it before printing the sentence.
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = "MacDesktopObservationError";
    this.code = code;
  }
}

export type MacDesktopHandleResolution = {
  observation: MacDesktopObservation;
  element: MacDesktopElement;
};

export type MacDesktopTurnRecording = {
  laneId: string;
  chatSessionId: string;
  turnId: string;
  filePath: string;
  startedAtMs: number;
  frameCount: number;
  lastFrameAtMs: number;
};

export type MacDesktopObservationsDeps = {
  projectRoot: string;
  /** Maps a lane to its worktree, so a relative `out` resolves where the agent works. */
  resolveLaneWorktreePath?: (laneId: string) => Promise<string | null> | string | null;
  /**
   * The one proof path. Wired to `computerUseArtifactBrokerService.ingest`, the
   * same broker `ade ios-sim proof` and `ade browser proof` reach through the
   * `ingest_computer_use_artifacts` tool — there is no second ingestion path.
   */
  ingestArtifacts?: (request: ComputerUseArtifactIngestionRequest) => ComputerUseArtifactIngestionResult;
  /** The lane's primary pull request URL, when it has one. */
  resolvePrimaryPrUrl?: (laneId: string) => Promise<string | null> | string | null;
  now?: () => number;
};

const isPathInside = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** Best-effort: an evicted frame, its element map, and its sidecar. */
function removeObservationFiles(observation: MacDesktopObservation): void {
  const candidates = [observation.screenshotPath, observation.mapPath].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const filePath of candidates) {
    const sidecar = `${filePath.slice(0, filePath.length - path.extname(filePath).length)}.json`;
    for (const target of [filePath, sidecar]) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // A file we cannot delete is a file the next sweep can try again.
      }
    }
  }
}

export function createMacDesktopObservations(deps: MacDesktopObservationsDeps) {
  const now = deps.now ?? (() => Date.now());
  /** laneId → most recent observations, newest last. */
  const byLane = new Map<string, MacDesktopObservation[]>();
  /** `${laneId}:${chatSessionId}` → the recording that will become a time-lapse. */
  const turnRecordings = new Map<string, MacDesktopTurnRecording>();

  const turnKey = (laneId: string, chatSessionId: string): string => `${laneId}:${chatSessionId}`;

  return {
    // -- observations -----------------------------------------------------
    remember(observation: MacDesktopObservation): MacDesktopObservation {
      const existing = byLane.get(observation.laneId) ?? [];
      const next = [...existing, observation];
      while (next.length > MAC_DESKTOP_OBSERVATION_RETENTION) {
        const evicted = next.shift();
        // The handle is dead the moment the observation leaves the window, so
        // the bytes are dead too. Without this the cache directory grows for
        // the life of the lane, one frame per agent action.
        if (evicted) removeObservationFiles(evicted);
      }
      byLane.set(observation.laneId, next);
      return observation;
    },

    latest(laneId: string): MacDesktopObservation | null {
      const list = byLane.get(laneId);
      return list?.length ? list[list.length - 1] : null;
    },

    list(laneId: string): MacDesktopObservation[] {
      return [...(byLane.get(laneId) ?? [])];
    },

    forgetLane(laneId: string): void {
      for (const observation of byLane.get(laneId) ?? []) removeObservationFiles(observation);
      byLane.delete(laneId);
      for (const key of [...turnRecordings.keys()]) {
        if (key.startsWith(`${laneId}:`)) turnRecordings.delete(key);
      }
    },

    /**
     * Turns `obs-<id>:e:<n>` back into an element.
     *
     * A handle from an observation that has aged out is refused rather than
     * silently re-resolved against the newest tree: element indices are
     * positional, so "the element that is now at index 12" is a different
     * button, and clicking it is worse than failing.
     */
    resolveHandle(laneId: string, handle: string): MacDesktopHandleResolution {
      const match = /^obs-([A-Za-z0-9_-]+):e:(\d+)$/.exec(handle.trim());
      if (!match) {
        throw new MacDesktopObservationError(
          MAC_DESKTOP_HANDLE_EXPIRED_CODE,
          `"${handle}" is not a Mac Desktop element handle. Observe the display and use a handle from that observation.`,
        );
      }
      const [, observationId, rawIndex] = match;
      const observation = (byLane.get(laneId) ?? []).find((entry) => entry.id === `obs-${observationId}` || entry.id === observationId);
      if (!observation) {
        throw new MacDesktopObservationError(
          MAC_DESKTOP_HANDLE_EXPIRED_CODE,
          `Handle ${handle} belongs to an observation ADE no longer holds. Observe again and use a fresh handle.`,
        );
      }
      const index = Number.parseInt(rawIndex, 10);
      const element = observation.elements.find((entry) => entry.index === index) ?? null;
      if (!element) {
        throw new MacDesktopObservationError(
          MAC_DESKTOP_HANDLE_EXPIRED_CODE,
          `Handle ${handle} is not in its observation any more. Observe again and use a fresh handle.`,
        );
      }
      return { observation, element };
    },

    // -- paths ------------------------------------------------------------
    /**
     * Where an ad-hoc screenshot lands when the caller named no `out`.
     *
     * The computer-use scratch root, which the proof broker already lists as an
     * allowed import root, so a scratch capture can still be promoted to proof.
     * Video does NOT come here — recordings and turn clips go to
     * `artifactPath`, because the thread plays them back over
     * `ade-artifact://`, which only serves `.ade/artifacts`.
     */
    scratchPath(stem: string, extension: string): string {
      return createComputerUseScratchPath(deps.projectRoot, stem, extension);
    },

    /**
     * Where video lands: recordings and per-turn clips.
     *
     * The artifact store rather than the scratch root, because the thread plays
     * these back through `ade-artifact://<path>` and the main process serves
     * that scheme only from inside `.ade/artifacts`.
     */
    artifactPath(stem: string, extension: string): string {
      return createComputerUseArtifactPath(deps.projectRoot, stem, extension);
    },

    /**
     * Where an observation frame (and its numbered element map) is written.
     *
     * Per lane, inside the one root `workToolsStateService` will serve from.
     * The lane id is sanitised because it becomes a directory name.
     */
    observationPath(laneId: string, stem: string, extension: string): string {
      const safeLane = laneId.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "lane";
      const safeStem = stem.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "frame";
      const dir = path.join(deps.projectRoot, MAC_DESKTOP_OBSERVATION_CACHE_DIR, safeLane);
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, `${safeStem}.${extension.replace(/^\./, "")}`);
    },

    /**
     * Writes the sidecar that binds a frame to its lane.
     *
     * `readObservationPreview` re-reads this file to decide whether the caller
     * is allowed to see the frame — it does not trust the path it was handed —
     * so a frame written without one is a frame the phone will refuse.
     */
    writeObservationSidecar(args: {
      imagePath: string;
      laneId: string;
      capturedAt: string;
      caption?: string | null;
    }): string | null {
      const sidecarPath = `${args.imagePath.slice(0, args.imagePath.length - path.extname(args.imagePath).length)}.json`;
      try {
        fs.writeFileSync(sidecarPath, `${JSON.stringify({
          filePath: args.imagePath,
          capturedAt: args.capturedAt,
          ownerLaneId: args.laneId,
          title: args.caption?.trim() || null,
        }, null, 2)}\n`, "utf8");
        return sidecarPath;
      } catch {
        // A frame without a sidecar is still a frame for this process; only
        // the mirror loses it, and losing a preview must not fail an action.
        return null;
      }
    },

    /**
     * Resolves a caller-supplied `out`.
     *
     * A relative path resolves against the lane's worktree, because that is
     * where the agent is working. Two roots may be written to: the lane
     * worktree and the OS temp directory. Both are agent-owned scratch space —
     * the proof skill writes `--out "$TMPDIR/…"` — and the earlier rule that
     * only the worktree counted made a documented command impossible.
     * Everything else — `../`, a symlink out, an absolute path somewhere else
     * — is refused by code, not by convention: an agent that can write one file
     * anywhere on the Mac can write `~/.zshrc`.
     */
    async resolveOutPath(args: { laneId: string; out: string }): Promise<string> {
      const raw = args.out.trim();
      if (!raw.length) {
        throw new MacDesktopObservationError(
          MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE,
          "An output path cannot be empty.",
        );
      }
      const worktree = (await deps.resolveLaneWorktreePath?.(args.laneId)) ?? deps.projectRoot;
      const realpathOrSelf = (candidate: string): string => {
        try {
          return fs.realpathSync(candidate);
        } catch {
          return path.resolve(candidate);
        }
      };
      // `$TMPDIR` on macOS is itself a symlink target (`/var` →
      // `/private/var`), so a caller can hand back either spelling of the same
      // directory; matching against both is what keeps one of them from being
      // refused as "outside".
      const roots = [path.resolve(worktree), path.resolve(os.tmpdir())].map((root) => ({
        path: root,
        real: realpathOrSelf(root),
      }));
      const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(roots[0]!.path, raw);
      const refuse = (): never => {
        throw new MacDesktopObservationError(
          MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE,
          `Screenshots must be written inside the lane worktree (${roots[0]!.path}) `
            + `or the system temp directory (${roots[1]!.path}). ${raw} is outside both.`,
        );
      };
      const matched = roots.find((root) =>
        isPathInside(root.path, absolute) || isPathInside(root.real, absolute)) ?? refuse();
      // Resolve symlinks on the deepest directory that already exists: a link
      // inside an allowed root pointing out of it passes the string check above.
      let probe = path.dirname(absolute);
      for (let depth = 0; depth < 64; depth += 1) {
        let real: string | null = null;
        try {
          real = fs.realpathSync(probe);
        } catch {
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent;
          continue;
        }
        if (real !== matched.real && !isPathInside(matched.real, real)) refuse();
        break;
      }
      // The loop above only ever inspected directories. A leaf that is itself a
      // symlink — `shot.png -> ~/.ssh/authorized_keys`, planted by anything that
      // can write one file in the worktree — passed every check and was then
      // written through by the driver. `lstat` is the one call that sees the
      // link rather than its target.
      // No leaf yet is the normal case — the capture is about to create it —
      // so the lookup failing is not the refusal; only a link is.
      let leafIsSymlink = false;
      try {
        leafIsSymlink = fs.lstatSync(absolute).isSymbolicLink();
      } catch {
        leafIsSymlink = false;
      }
      if (leafIsSymlink) refuse();
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      return absolute;
    },

    // -- proof ------------------------------------------------------------
    /**
     * Files a capture in the proof drawer.
     *
     * Same broker, same backend descriptor shape and the same owner rules the
     * other surfaces use: the lane, the calling chat, and — when the lane has a
     * primary pull request — that PR as a `github_pr` owner with the existing
     * `published_to` relation.
     */
    async ingestProof(args: {
      laneId: string;
      chatSessionId?: string | null;
      toolName: string;
      title: string;
      caption?: string | null;
      filePath: string;
      kind: "screenshot" | "video_recording";
      metadata?: Record<string, unknown> | null;
    }): Promise<ComputerUseArtifactIngestionResult | null> {
      if (!deps.ingestArtifacts) return null;
      const owners: ComputerUseArtifactOwner[] = [{ kind: "lane", id: args.laneId, relation: "attached_to" }];
      const chatSessionId = args.chatSessionId?.trim();
      if (chatSessionId) owners.push({ kind: "chat_session", id: chatSessionId, relation: "attached_to" });
      const prUrl = (await deps.resolvePrimaryPrUrl?.(args.laneId))?.trim() || null;
      if (prUrl) owners.push({ kind: "github_pr", id: prUrl, relation: "published_to" });
      return deps.ingestArtifacts({
        backend: {
          name: MAC_DESKTOP_PROOF_BACKEND_NAME,
          style: "manual",
          toolName: args.toolName,
        },
        callerRoot: deps.projectRoot,
        inputs: [{
          kind: args.kind,
          title: args.title,
          description: args.caption?.trim() || null,
          path: args.filePath,
          ...(args.metadata ? { metadata: args.metadata } : {}),
        }],
        owners,
      });
    },

    // -- the per-turn time-lapse -----------------------------------------
    /**
     * Records that a turn has started touching the desktop.
     *
     * Returns the recording to start when this is the first action of the turn,
     * and null when one is already running — the caller then only has to note
     * the frame.
     */
    beginTurnRecording(args: {
      laneId: string;
      chatSessionId: string;
      turnId: string;
      filePath: string;
    }): MacDesktopTurnRecording | null {
      const key = turnKey(args.laneId, args.chatSessionId);
      const existing = turnRecordings.get(key);
      if (existing && existing.turnId === args.turnId) return null;
      const atMs = now();
      const recording: MacDesktopTurnRecording = {
        laneId: args.laneId,
        chatSessionId: args.chatSessionId,
        turnId: args.turnId,
        filePath: args.filePath,
        startedAtMs: atMs,
        frameCount: 0,
        lastFrameAtMs: 0,
      };
      turnRecordings.set(key, recording);
      return recording;
    },

    /**
     * Counts one action against the turn's clip.
     *
     * Rate-limited to one frame a second and capped, so a loop of two hundred
     * clicks produces a clip somebody can watch rather than a flicker.
     */
    noteTurnFrame(laneId: string, chatSessionId: string): boolean {
      const recording = turnRecordings.get(turnKey(laneId, chatSessionId));
      if (!recording) return false;
      const atMs = now();
      if (recording.frameCount >= MAC_DESKTOP_TIME_LAPSE_MAX_FRAMES) return false;
      if (atMs - recording.lastFrameAtMs < MAC_DESKTOP_TIME_LAPSE_MIN_FRAME_GAP_MS) return false;
      recording.frameCount += 1;
      recording.lastFrameAtMs = atMs;
      return true;
    },

    getTurnRecording(laneId: string, chatSessionId: string): MacDesktopTurnRecording | null {
      return turnRecordings.get(turnKey(laneId, chatSessionId)) ?? null;
    },

    /**
     * The turn clip running on this lane, whichever chat opened it.
     *
     * One lane has one writer in the helper, so "is a clip recording on this
     * lane" is a lane question, not a chat question. Asking it per chat is what
     * let a user recording start on top of a running turn clip and take its
     * file over.
     */
    findTurnRecordingForLane(laneId: string): MacDesktopTurnRecording | null {
      for (const recording of turnRecordings.values()) {
        if (recording.laneId === laneId) return recording;
      }
      return null;
    },

    /** Forgets every turn clip on the lane and says which ones there were. */
    endTurnRecordingsForLane(laneId: string): MacDesktopTurnRecording[] {
      const ended: MacDesktopTurnRecording[] = [];
      for (const [key, recording] of [...turnRecordings]) {
        if (recording.laneId !== laneId) continue;
        turnRecordings.delete(key);
        ended.push(recording);
      }
      return ended;
    },

    endTurnRecording(laneId: string, chatSessionId: string): MacDesktopTurnRecording | null {
      const key = turnKey(laneId, chatSessionId);
      const recording = turnRecordings.get(key) ?? null;
      turnRecordings.delete(key);
      return recording;
    },
  };
}

export type MacDesktopObservations = ReturnType<typeof createMacDesktopObservations>;
