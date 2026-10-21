/**
 * First-run discovery, run in a child process.
 *
 * Discovery reads every provider's history through the importer's discoverers,
 * and those read synchronously: measured on a Mac Studio with a real history,
 * one discovery held the event loop for up to 2.7 s at a time (Claude 0.5-1.5 s,
 * Pi 1 s, Cursor 0.6 s), and one cold chat list for 0.8-1 s. A budget
 * (`Promise.race`) cannot interrupt synchronous work, so on the main process
 * that froze every window while setup was up. Here the reading runs in a child
 * (`runJsonChildProcess`: `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, the
 * bundled `.cjs` in a build and the `.ts` entry in a source run), one request
 * per child, and the main process only waits on a pipe. A child still running
 * when ADE quits is killed by {@link terminateOnboardingDiscoveryWorkers}.
 *
 * The chat lists a child reads come back with its answer and are kept here for
 * the setup session, so a project's picker opening after discovery is answered
 * from memory, and a cold one sends discovery's read of the other providers
 * along instead of reading those stores again.
 *
 * When the child cannot start (a build without the helper), the same request
 * runs in this process, as it did before, and a warning says so. A child that
 * runs past its ceiling is killed and setup gets an empty answer: running the
 * same stuck read here would freeze the app.
 */
import path from "node:path";
import type { OnboardingProjectChat, OnboardingProjectDiscovery } from "../../../shared/types";
import { resolveDeviceDisplayNameSettled } from "../../../../../ade-cli/src/services/sync/deviceRegistryService";
import {
  resolveJsonChildWorkerPath,
  runJsonChildProcess,
  terminateJsonChildProcesses,
  type JsonChildProcessSet,
} from "../shared/jsonChildProcess";
import { pathKey } from "../shared/pathCompare";
import {
  createOnboardingChatCache,
  onboardingChatListIsFresh,
  type DiscoveryLogger,
} from "./onboardingProjectDiscovery";
import {
  parseOnboardingDiscoveryResponse,
  runOnboardingDiscoveryRequest,
  type OnboardingDiscoveryRequest,
  type OnboardingDiscoveryResponse,
} from "./onboardingDiscoveryWorker";

/**
 * A ceiling for a wedged child, far past a normal run (discovery measured at
 * 3-5 s, a chat list at 1-2 s). The IPC budgets for these calls
 * (`ipcTimeouts.ts`) sit above them.
 */
const WORKER_TIMEOUT_MS: Record<OnboardingDiscoveryRequest["kind"], number> = {
  discover: 60_000,
  listChats: 30_000,
};
/** Bounds a malformed answer; a real one (40 projects, a few thousand chats) is well under 2 MB. */
const WORKER_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

let cache = createOnboardingChatCache();
const inFlightLists = new Map<string, Promise<OnboardingProjectChat[]>>();
/** Every discovery child still running, so app quit can end a wedged one. */
const liveWorkers: JsonChildProcessSet = new Set();

/** Kills every discovery child still running. Called from the app's shutdown path. */
export function terminateOnboardingDiscoveryWorkers(): number {
  return terminateJsonChildProcesses(liveWorkers);
}

type WorkerOutcome =
  | { kind: "answered"; response: OnboardingDiscoveryResponse }
  /** The child could not run at all: the request has not been read anywhere. */
  | { kind: "unavailable"; reason: string }
  /** The child ran and failed, hung, or answered garbage: do not run it again here. */
  | { kind: "failed"; reason: string };

async function runInChild(request: OnboardingDiscoveryRequest): Promise<WorkerOutcome> {
  const outcome = await runJsonChildProcess({
    workerPath: resolveJsonChildWorkerPath({
      envVar: "ADE_ONBOARDING_DISCOVERY_WORKER_PATH",
      baseDir: __dirname,
      bundledName: "onboardingDiscoveryWorker.cjs",
      sourceEntryName: "onboardingDiscoveryWorkerEntry.ts",
    }),
    request,
    live: liveWorkers,
    timeoutMs: WORKER_TIMEOUT_MS[request.kind],
    maxOutputBytes: WORKER_MAX_OUTPUT_BYTES,
  });
  if (outcome.kind !== "answered") return outcome;
  const response = parseOnboardingDiscoveryResponse(outcome.value);
  return response ? { kind: "answered", response } : { kind: "failed", reason: "unreadable answer" };
}

/** The child's log lines, written to this process's log as if discovery ran here. */
function replayLogs(response: OnboardingDiscoveryResponse, logger?: DiscoveryLogger): void {
  for (const line of response.logs) {
    if (line.level === "warn") logger?.warn?.(line.message, line.fields);
    else logger?.info?.(line.message, line.fields);
  }
}

type AnsweredResponse = Extract<OnboardingDiscoveryResponse, { ok: true }>;

/** The request's answer, or null (logged) when it failed; never throws. */
async function runRequest(
  request: OnboardingDiscoveryRequest,
  logger?: DiscoveryLogger,
): Promise<AnsweredResponse | null> {
  const outcome = await runInChild(request);
  if (outcome.kind === "unavailable") {
    logger?.warn?.("onboarding.discovery_worker_unavailable", { kind: request.kind, reason: outcome.reason });
    const response = await runOnboardingDiscoveryRequest(request);
    replayLogs(response, logger);
    return response.ok ? response : null;
  }
  if (outcome.kind === "failed") {
    logger?.warn?.("onboarding.discovery_worker_failed", { kind: request.kind, reason: outcome.reason });
    return null;
  }
  replayLogs(outcome.response, logger);
  if (!outcome.response.ok) {
    logger?.warn?.("onboarding.discovery_failed", { kind: request.kind, error: outcome.response.error });
    return null;
  }
  return outcome.response;
}

/** This computer's git projects with coding-agent history, for first-run setup. */
export async function discoverOnboardingProjects(args: {
  knownRoots: string[];
  logger?: DiscoveryLogger;
}): Promise<OnboardingProjectDiscovery> {
  const [response, deviceName] = await Promise.all([
    runRequest({ kind: "discover", knownRoots: args.knownRoots, now: Date.now() }, args.logger),
    // The name the user gave this computer (macOS ComputerName), not its network hostname.
    resolveDeviceDisplayNameSettled(),
  ]);
  // A fresh discovery starts a fresh setup session: its lists replace the last one's.
  if (response) cache = response.cache;
  const machineName = deviceName.replace(/\.(local|lan|home)$/i, "").trim();
  return { machineName: machineName || "this computer", projects: response?.kind === "discover" ? response.projects : [] };
}

/** One project's importable chats for setup's picker; from memory when discovery or an earlier open read them. */
export function listOnboardingProjectChats(args: {
  rootPath: string;
  logger?: DiscoveryLogger;
}): Promise<OnboardingProjectChat[]> {
  const rootPath = path.resolve(args.rootPath);
  const key = pathKey(rootPath);
  const now = Date.now();
  const listed = cache.projectChatLists[key];
  if (onboardingChatListIsFresh(listed, now)) return Promise.resolve(listed.chats);
  const inFlight = inFlightLists.get(key);
  if (inFlight) return inFlight;
  const sessionCache = cache;
  const otherProviderChats = onboardingChatListIsFresh(sessionCache.otherProviderChats, now)
    ? sessionCache.otherProviderChats
    : null;
  const read = runRequest({ kind: "listChats", rootPath, now, otherProviderChats }, args.logger)
    .then((response) => {
      if (response?.kind !== "listChats") return [];
      // The child's cache holds the list it just read for this project (and
      // its read of the other providers when it had to make one).
      Object.assign(sessionCache.projectChatLists, response.cache.projectChatLists);
      if (!sessionCache.otherProviderChats && response.cache.otherProviderChats) {
        sessionCache.otherProviderChats = response.cache.otherProviderChats;
      }
      return response.chats;
    })
    .finally(() => {
      inFlightLists.delete(key);
    });
  inFlightLists.set(key, read);
  return read;
}
