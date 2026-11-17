import { useSyncExternalStore } from "react";
import {
  CLOUD_LAUNCH_IN_PROGRESS,
  newCloudLaunchId,
  newCloudMessageId,
  type CloudLaunchMessage,
  type CloudLaunchRecord,
  type CloudLaunchStartRequest,
} from "../../shared/accountCloudLaunches";
import { normalizeGitRemoteIdentity } from "../../shared/crossMachineHandoff";
import { forwardSignalToSentry } from "../../shared/sentry/logBridge";
import { createBackoffPoller, type BackoffPoller } from "../lib/backoffPoller";
import { isAdeAvailable } from "../lib/adeAvailability";
import { refreshCloudMachines } from "../components/remoteTargets/useCloudMachines";
import { accountProjectListUserId, onAccountProjectListAccountChange } from "./accountProjectListClient";

/**
 * Chats started on ADE Cloud from the account server (`window.ade.cloudLaunches`),
 * for a client with no computer of the person's own. One store for the page:
 * the launches this tab started or found in progress, each with its last
 * record and its queued messages.
 *
 * One poll for every launch: a read every 3 s, slowing to 10 s while nothing
 * changes, paused while the page is hidden, and stopped once no launch is in
 * progress and no message waits for its chat. The reads run one at a time,
 * so a page never holds more than one of the browser's connections to the
 * account server for this.
 */

export type AccountCloudLaunchEntry = {
  launchId: string;
  record: CloudLaunchRecord | null;
  /** The first message and the ones queued after it, as this tab knows them. */
  messages: CloudLaunchMessage[];
  /** The start failed before the server kept anything: the message is not sent. */
  startError: string | null;
  /** What the launch was started with, for a retry of a start that failed. */
  request: CloudLaunchStartRequest | null;
  /** This tab started it (a fresh check animation plays only for these). */
  startedHere: boolean;
  /** The repository's origin as this tab knew it at the start (before the server's record). */
  origin: string | null;
};

type Snapshot = {
  entries: readonly AccountCloudLaunchEntry[];
  /** The first `active` read finished (or failed). */
  known: boolean;
};

let snapshot: Snapshot = { entries: [], known: false };
const listeners = new Set<() => void>();
let poller: BackoffPoller | null = null;
let discovered = false;
/** Bumped when the account changes: a read the last account started lands nowhere. */
let accountEpoch = 0;
/** Launches whose start (or Retry) is on its way: the poll waits for its answer. */
const startsInFlight = new Set<string>();
/** Launches found by the first look whose messages read failed: the poll reads them again. */
const messagesUnread = new Set<string>();

// Another account here: the last account's launches and messages go, and the new one is looked up.
onAccountProjectListAccountChange(() => {
  accountEpoch += 1;
  poller?.stop();
  poller = null;
  discovered = false;
  startsInFlight.clear();
  messagesUnread.clear();
  snapshot = { entries: [], known: false };
  emit();
  if (listeners.size > 0) {
    discovered = true;
    void discover();
  }
});

/**
 * Launches the person hid, per account, kept across reloads: the first look
 * lists failures of the last day, and a hidden one stays off the page.
 * Pruned after two weeks (the server lists a failure for a day).
 */
const HIDDEN_KEY_PREFIX = "ade.cloudLaunches.hidden.v1:";
const HIDDEN_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const HIDDEN_MAX = 200;

function hiddenKey(): string | null {
  const userId = accountProjectListUserId();
  return userId ? `${HIDDEN_KEY_PREFIX}${userId}` : null;
}

function readHidden(): Record<string, number> {
  const key = hiddenKey();
  if (!key) return {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(
      (pair): pair is [string, number] => typeof pair[1] === "number" && now - pair[1] < HIDDEN_KEEP_MS,
    ));
  } catch {
    return {};
  }
}

/** The hidden ids of the signed-in account, read from storage once per account. */
let hiddenCache: { key: string | null; ids: ReadonlySet<string> } | null = null;
function hiddenLaunchIds(): ReadonlySet<string> {
  const key = hiddenKey();
  if (hiddenCache?.key !== key) hiddenCache = { key, ids: new Set(Object.keys(readHidden())) };
  return hiddenCache.ids;
}

function rememberHidden(launchId: string): void {
  const key = hiddenKey();
  if (!key) return;
  const next = Object.entries({ ...readHidden(), [launchId]: Date.now() })
    .sort((a, b) => b[1] - a[1])
    .slice(0, HIDDEN_MAX);
  try {
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(next)));
    hiddenCache = { key, ids: new Set(next.map(([id]) => id)) };
  } catch {
    // Storage full or off: the card stays hidden until a reload.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setEntries(next: readonly AccountCloudLaunchEntry[], known = snapshot.known): void {
  snapshot = { entries: next, known };
  emit();
  syncPoller();
}

function patchEntry(launchId: string, patch: Partial<AccountCloudLaunchEntry>): void {
  const index = snapshot.entries.findIndex((entry) => entry.launchId === launchId);
  if (index < 0) return;
  const before = snapshot.entries[index]!;
  const next = snapshot.entries.slice();
  next[index] = { ...before, ...patch };
  setEntries(next);
  // A chat that got its lane: read the account's computers again, so the new
  // lane shows in the lane lists and the Work list.
  if (!before.record?.sessionId && next[index]!.record?.sessionId) refreshCloudMachines();
}

/** A read the poll or the first look made failed; the next tick tries again. */
function noteReadFailed(read: string, error: unknown): void {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : null;
  forwardSignalToSentry("web.cloud_launch_read_failed", { read, code }, `cloud_launch_read_failed:${read}`, "info");
}

/**
 * The server's messages, with the ones this tab holds that the server does
 * not list yet: a send still on its way, or one that failed here ("Not sent").
 */
function mergeMessages(local: readonly CloudLaunchMessage[], server: readonly CloudLaunchMessage[]): CloudLaunchMessage[] {
  const known = new Set(server.map((message) => message.messageId));
  const localOnly = local.filter((message) => !known.has(message.messageId) && message.state !== "delivered");
  return localOnly.length ? [...server, ...localOnly].sort((a, b) => a.seq - b.seq) : [...server];
}

function messagesSignature(messages: readonly CloudLaunchMessage[]): string {
  return messages.map((message) => `${message.messageId}:${message.state}`).join(",");
}

const isWaiting = (message: CloudLaunchMessage): boolean => message.state === "queued" || message.state === "sending";

function messagesWaiting(entry: AccountCloudLaunchEntry): boolean {
  return entry.messages.some(isWaiting);
}

/**
 * After the chat started (the record's last change) or the message was
 * typed, whichever is later, a waiting message is read again this long; one
 * the computer never takes then stays "Waiting" without a poll.
 */
const QUEUED_AFTER_CHAT_READ_MS = 10 * 60_000;

function messagesWaitingRecently(entry: AccountCloudLaunchEntry, now = Date.now()): boolean {
  const chatAt = entry.record?.updatedAt ?? 0;
  return entry.messages.some((message) =>
    isWaiting(message)
    && now - Math.max(message.createdAt, chatAt) < QUEUED_AFTER_CHAT_READ_MS);
}

function bridge() {
  const value = typeof window !== "undefined" ? window.ade?.cloudLaunches : undefined;
  return value && isAdeAvailable(value.start) ? value : null;
}

/** Whether this client starts ADE Cloud chats from the account server (the web app). */
export function accountCloudLaunchesAvailable(): boolean {
  return bridge() != null;
}

export function launchInProgress(entry: AccountCloudLaunchEntry): boolean {
  if (entry.startError) return false;
  return !entry.record || CLOUD_LAUNCH_IN_PROGRESS.has(entry.record.state);
}

/**
 * The poll reads this launch: still in progress, or its chat started while
 * messages after the first wait for it (the computer takes those after it
 * reports the chat, so the read that sees the chat still finds them queued).
 */
function launchNeedsRead(entry: AccountCloudLaunchEntry): boolean {
  if (launchInProgress(entry) || messagesUnread.has(entry.launchId)) return true;
  return Boolean(entry.record?.sessionId) && entry.record?.state !== "failed" && entry.record?.state !== "cancelled" && messagesWaitingRecently(entry);
}

function signatureOf(record: CloudLaunchRecord | null): string {
  if (!record) return "";
  return `${record.state}|${record.updatedAt}|${record.stages.map((stage) => `${stage.id}:${stage.status}`).join(",")}|${record.signIn?.jobId ?? ""}`;
}

/** One poll tick: each launch in progress, one at a time. Resolves whether anything changed. */
async function readInProgress(): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  let changed = false;
  for (const entry of snapshot.entries.filter(launchNeedsRead)) {
    // A start still on its way has nothing to read yet.
    if ((entry.startedHere && !entry.record) || startsInFlight.has(entry.launchId)) continue;
    let read = "status";
    try {
      if (launchInProgress(entry)) {
        const record = await api.status(entry.launchId);
        // A Retry that answered while this read was out has the newer record.
        const current = snapshot.entries.find((candidate) => candidate.launchId === entry.launchId);
        if (current?.record === entry.record && !startsInFlight.has(entry.launchId) && signatureOf(record) !== signatureOf(entry.record)) {
          changed = true;
          patchEntry(entry.launchId, { record });
        }
      }
      // Queued messages move to `delivered` once the chat exists; read them while any wait.
      if (messagesWaiting(entry) || messagesUnread.has(entry.launchId)) {
        read = "messages";
        const { messages } = await api.messages(entry.launchId);
        messagesUnread.delete(entry.launchId);
        const local = snapshot.entries.find((candidate) => candidate.launchId === entry.launchId)?.messages ?? entry.messages;
        const merged = mergeMessages(local, messages);
        if (messagesSignature(merged) !== messagesSignature(local)) {
          changed = true;
          patchEntry(entry.launchId, { messages: merged });
        }
      }
    } catch (error) {
      // A failed read keeps the last record; the next tick tries again.
      noteReadFailed(read, error);
    }
  }
  return changed;
}

function syncPoller(): void {
  const wanted = snapshot.entries.some(launchNeedsRead) && listeners.size > 0;
  if (wanted && !poller) {
    poller = createBackoffPoller({
      baseMs: 3_000,
      maxMs: 10_000,
      isActive: () => snapshot.entries.some(launchNeedsRead),
      read: readInProgress,
    });
    poller.start();
  } else if (!wanted && poller) {
    poller.stop();
    poller = null;
  }
}

/** Reads the account's launches in progress once (and failures of the last day), on the first subscriber. */
async function discover(): Promise<void> {
  const api = bridge();
  if (!api) {
    setEntries(snapshot.entries, true);
    return;
  }
  const epoch = accountEpoch;
  try {
    const { launches } = await api.active();
    if (epoch !== accountEpoch) return;
    const known = new Map(snapshot.entries.map((entry) => [entry.launchId, entry]));
    const hidden = hiddenLaunchIds();
    const added: AccountCloudLaunchEntry[] = [];
    for (const summary of launches) {
      if (known.has(summary.launchId) || hidden.has(summary.launchId)) continue;
      added.push({ launchId: summary.launchId, record: null, messages: [], startError: null, request: null, startedHere: false, origin: summary.projectOrigin });
    }
    setEntries([...snapshot.entries, ...added], true);
    // Fill each found launch's record at once; the poll keeps it current.
    for (const entry of added) {
      void api.status(entry.launchId).then((record) => patchEntry(entry.launchId, { record }), (error: unknown) => noteReadFailed("status", error));
      void api.messages(entry.launchId).then(
        ({ messages }) => {
          if (epoch !== accountEpoch) return;
          // A message queued while this read was out stays.
          const current = snapshot.entries.find((candidate) => candidate.launchId === entry.launchId);
          patchEntry(entry.launchId, { messages: mergeMessages(current?.messages ?? [], messages) });
        },
        (error: unknown) => {
          if (epoch !== accountEpoch) return;
          noteReadFailed("messages", error);
          messagesUnread.add(entry.launchId);
          syncPoller();
        },
      );
    }
  } catch (error) {
    if (epoch !== accountEpoch) return;
    noteReadFailed("active", error);
    // Look again on the next subscriber (a page that opens later).
    discovered = false;
    setEntries(snapshot.entries, true);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!discovered) {
    discovered = true;
    void discover();
  }
  syncPoller();
  return () => {
    listeners.delete(listener);
    syncPoller();
  };
}

const getSnapshot = (): Snapshot => snapshot;

export function useAccountCloudLaunches(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The launches of one repository (any spelling of its origin). */
export function launchesForOrigin(entries: readonly AccountCloudLaunchEntry[], origin: string | null): AccountCloudLaunchEntry[] {
  const identity = normalizeGitRemoteIdentity(origin);
  if (!identity) return [];
  // A launch found before the account was known, then hidden on an earlier visit, stays off.
  const hidden = hiddenLaunchIds();
  return entries.filter((entry) => {
    if (hidden.has(entry.launchId)) return false;
    const launchOrigin = entry.record?.projectOrigin ?? entry.origin;
    return normalizeGitRemoteIdentity(launchOrigin) === identity;
  });
}

export type StartAccountCloudChat = {
  /** Left out, a new one. The launch's `launch` args, when sent, carry the same id. */
  launchId?: string;
  /** The account's project; left out, the server reads `origin` (a GitHub repository). */
  accountProjectId?: string | null;
  origin: string;
  provider: string;
  modelId: string;
  effort?: string | null;
  fast?: boolean;
  /** The chat's permission mode; left out, `default`. */
  permissions?: string | null;
  prompt: string;
  /** Left out, the server picks Small. */
  sizeId?: CloudLaunchStartRequest["sizeId"];
  sizeChoice?: CloudLaunchStartRequest["sizeChoice"];
  /** Left out, a new lane named from the first message. */
  lane?: CloudLaunchStartRequest["lane"];
  /** The launch as the app set it up (`cloudLaunchAppArgs`), for `CloudServerLaunchRequest.launch`. */
  launch?: CloudLaunchStartRequest["launch"] | null;
};

/**
 * Starts a chat on a new ADE Cloud computer: the first message makes the
 * computer. The message is stored with the launch at once, so the tab may
 * close. Answers the launch id; a failed start keeps the entry (and its
 * message) with the reason, for Retry.
 */
export async function startAccountCloudChat(input: StartAccountCloudChat): Promise<string> {
  const api = bridge();
  if (!api) throw new Error("ADE Cloud chats start from the web app here.");
  const launchId = input.launchId ?? newCloudLaunchId();
  const messageId = newCloudMessageId();
  const request: CloudLaunchStartRequest = {
    launchId,
    kind: "chat",
    // The server reads the origin from the account's project when there is one.
    project: input.accountProjectId ? { accountProjectId: input.accountProjectId } : { origin: input.origin },
    ...(input.sizeId ? { sizeId: input.sizeId } : {}),
    ...(input.sizeChoice ? { sizeChoice: input.sizeChoice } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    chat: {
      provider: input.provider,
      modelId: input.modelId,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.fast ? { fast: true } : {}),
      permissions: input.permissions || "default",
      prompt: input.prompt,
      messageId,
    },
    madeBy: { kind: "person" },
    ...(input.launch ? { launch: input.launch } : {}),
  };
  const now = Date.now();
  const firstMessage: CloudLaunchMessage = {
    messageId,
    seq: 1,
    text: input.prompt,
    provider: input.provider,
    modelId: input.modelId,
    state: "queued",
    sessionId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  setEntries([{ launchId, record: null, messages: [firstMessage], startError: null, request, startedHere: true, origin: input.origin }, ...snapshot.entries]);
  await runStart(launchId, request);
  return launchId;
}

async function runStart(launchId: string, request: CloudLaunchStartRequest, retry = false): Promise<void> {
  const api = bridge();
  if (!api) return;
  startsInFlight.add(launchId);
  try {
    const record = await api.start(retry ? { ...request, retry: true } : request);
    startsInFlight.delete(launchId);
    patchEntry(launchId, { record, startError: null });
  } catch (error) {
    startsInFlight.delete(launchId);
    patchEntry(launchId, { startError: error instanceof Error ? error.message : String(error) });
  }
}

/** Starts again a launch whose start failed, or whose computer failed before its agent started. */
export async function retryAccountCloudLaunch(launchId: string): Promise<void> {
  const entry = snapshot.entries.find((candidate) => candidate.launchId === launchId);
  const request = entry?.request ?? entry?.record?.request ?? null;
  if (!entry || !request) return;
  patchEntry(launchId, { startError: null, record: entry.record ? { ...entry.record, state: "making", error: null } : null });
  await runStart(launchId, request, entry.record != null);
}

/** Queues a message for a launch whose chat doesn't exist yet. */
export async function queueAccountCloudMessage(launchId: string, text: string): Promise<void> {
  const api = bridge();
  const entry = snapshot.entries.find((candidate) => candidate.launchId === launchId);
  if (!api || !entry) return;
  const messageId = newCloudMessageId();
  const now = Date.now();
  const optimistic: CloudLaunchMessage = {
    messageId,
    seq: entry.messages.length + 1,
    text,
    provider: null,
    modelId: null,
    state: "queued",
    sessionId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  patchEntry(launchId, { messages: [...entry.messages, optimistic] });
  try {
    const saved = await api.addMessage(launchId, { messageId, text });
    const current = snapshot.entries.find((candidate) => candidate.launchId === launchId);
    if (current) patchEntry(launchId, { messages: current.messages.map((message) => (message.messageId === messageId ? saved : message)) });
  } catch (error) {
    const current = snapshot.entries.find((candidate) => candidate.launchId === launchId);
    if (current) {
      patchEntry(launchId, {
        messages: current.messages.map((message) => (message.messageId === messageId
          ? { ...message, state: "failed", error: error instanceof Error ? error.message : String(error) }
          : message)),
      });
    }
  }
  poller?.kick();
}

/** Cancels a launch (deletes its computer before the agent starts). */
export async function cancelAccountCloudLaunch(launchId: string): Promise<void> {
  const api = bridge();
  if (!api) return;
  const record = await api.cancel(launchId);
  patchEntry(launchId, { record });
}

/**
 * Whether the person may take this launch's card off the page: its start
 * failed, or it ended with nothing left to send. A launch still on its way,
 * or a chat whose later messages still wait, stays.
 */
export function accountCloudLaunchHideable(entry: AccountCloudLaunchEntry): boolean {
  return entry.startError != null || !launchNeedsRead(entry);
}

/** Takes a finished or failed launch off this page's cards. */
export function hideAccountCloudLaunch(launchId: string): void {
  const entry = snapshot.entries.find((candidate) => candidate.launchId === launchId);
  if (!entry || !accountCloudLaunchHideable(entry)) return;
  rememberHidden(launchId);
  setEntries(snapshot.entries.filter((candidate) => candidate.launchId !== launchId));
}

/** Reads now (after a sign-in code was sent, or the person came back). */
export function refreshAccountCloudLaunches(): void {
  poller?.kick();
}
