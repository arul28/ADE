import { describe, expect, it, vi } from "vitest";
import type { SyncCredentialStore } from "../credentials/credentialStore";
import {
  ACCOUNT_SESSION_ROTATION_JOURNAL_KEY,
  ROTATION_JOURNAL_PEER_MAX_AGE_MS,
  createRotationJournal,
  parseRotationJournal,
  type RotationJournalEntry,
} from "./accountSessionRotationJournal";

/**
 * The journal decides, in one place, whether this process may POST a rotating
 * grant right now. Every branch of that decision is a real incident: a wrongly
 * granted begin burns a live peer's grant, and a wrongly refused one wedges
 * every process behind a rotation nobody is running.
 *
 * These tests drive the store directly, which is the only way to state "the
 * journal already holds THIS entry" without running a whole refresh.
 */

const OUR_PID = 4242;
const PEER_PID = 999;
const NOW_MS = Date.parse("2026-08-20T12:00:00.000Z");

function createStore(): SyncCredentialStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
    getSync: (key) => values.get(key) ?? null,
    setSync: (key, value) => void values.set(key, value),
    deleteSync: (key) => void values.delete(key),
    updateKeySync: (key, mutator) => {
      const next = mutator(values.get(key) ?? null);
      if (next === undefined) return;
      if (next === null) values.delete(key);
      else values.set(key, next);
    },
  };
}

function writeEntry(
  store: SyncCredentialStore,
  patch: Partial<RotationJournalEntry> = {},
): void {
  store.setSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY, JSON.stringify({
    version: 1,
    oldRefreshTokenHash: "gen-old",
    startedAt: new Date(NOW_MS - 1_000).toISOString(),
    pid: PEER_PID,
    source: "desktop",
    userId: "user_1",
    ...patch,
  }));
}

function readEntry(store: SyncCredentialStore): RotationJournalEntry | null {
  return parseRotationJournal(store.getSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY));
}

function buildJournal(
  store: SyncCredentialStore,
  options: { pidAlive?: (pid: number) => boolean; nowMs?: number } = {},
) {
  const log = vi.fn();
  const journal = createRotationJournal({
    credentialStore: store,
    now: () => options.nowMs ?? NOW_MS,
    pid: OUR_PID,
    source: "cli",
    log,
    pidAlive: options.pidAlive ?? (() => false),
  });
  const actions = (): string[] => log.mock.calls.map(([entry]) => String(entry.action));
  return { journal, log, actions };
}

const BEGIN = { oldRefreshTokenHash: "gen-old", userId: "user_1" };

describe("account session rotation journal", () => {
  it("writes an owned entry when no journal exists", () => {
    const store = createStore();
    const { journal, actions } = buildJournal(store);

    expect(journal.tryBegin(BEGIN)).toEqual({ kind: "acquired", takeover: false });
    expect(readEntry(store)).toMatchObject({ oldRefreshTokenHash: "gen-old", pid: OUR_PID });
    expect(actions()).toEqual(["rotation_journal_begin"]);
  });

  /**
   * A live peer is waited out, never raced: Clerk refresh tokens are single-use,
   * so a second POST against one generation makes the loser look signed out.
   */
  it("refuses to begin behind a live, fresh peer", () => {
    const store = createStore();
    writeEntry(store);
    const { journal, actions } = buildJournal(store, { pidAlive: (pid) => pid === PEER_PID });

    expect(journal.tryBegin(BEGIN).kind).toBe("peer_in_flight");
    // The peer's entry is left exactly as it was, and the refusal is reported.
    expect(readEntry(store)).toMatchObject({ pid: PEER_PID, source: "desktop" });
    expect(actions()).toEqual(["rotation_journal_interrupted"]);
  });

  it("takes over a dead peer's entry as an interrupted rotation", () => {
    const store = createStore();
    writeEntry(store);
    const { journal, actions } = buildJournal(store);

    expect(journal.tryBegin(BEGIN)).toEqual({ kind: "acquired", takeover: true });
    expect(readEntry(store)).toMatchObject({ pid: OUR_PID });
    expect(actions()).toEqual(["rotation_journal_interrupted", "rotation_journal_begin"]);
  });

  /**
   * A wedged owner or a reused pid must not block every peer forever, so an
   * entry older than the peer window is taken over even while its pid is live.
   */
  it("takes over a live peer's entry once it has aged out", () => {
    const store = createStore();
    writeEntry(store, {
      startedAt: new Date(NOW_MS - ROTATION_JOURNAL_PEER_MAX_AGE_MS - 1).toISOString(),
    });
    const { journal } = buildJournal(store, { pidAlive: () => true });

    expect(journal.tryBegin(BEGIN)).toEqual({ kind: "acquired", takeover: true });
    expect(readEntry(store)).toMatchObject({ pid: OUR_PID });
  });

  /**
   * Our OWN surviving entry means an exchange ran and never made its replacement
   * durable. That is an interrupted rotation exactly like a dead peer's — and
   * the entry must NOT be rewritten, because restamping `startedAt` keeps a
   * process that fails the same write forever young in every peer's eyes.
   */
  it("reports our own surviving entry as a takeover without restamping it", () => {
    const store = createStore();
    const startedAt = new Date(NOW_MS - 30_000).toISOString();
    writeEntry(store, { pid: OUR_PID, startedAt, source: "cli" });
    const { journal, actions } = buildJournal(store);

    expect(journal.tryBegin(BEGIN)).toEqual({ kind: "acquired", takeover: true });
    expect(readEntry(store)).toMatchObject({ startedAt, pid: OUR_PID });
    // One uniform acquired tail: the interruption AND the begin are both logged.
    expect(actions()).toEqual(["rotation_journal_interrupted", "rotation_journal_begin"]);
  });

  it("reports our own surviving entry the same way without an atomic store", () => {
    const store = createStore();
    const startedAt = new Date(NOW_MS - 30_000).toISOString();
    writeEntry(store, { pid: OUR_PID, startedAt, source: "cli" });
    delete (store as { updateKeySync?: unknown }).updateKeySync;
    const { journal, actions } = buildJournal(store);

    expect(journal.tryBegin(BEGIN)).toEqual({ kind: "acquired", takeover: true });
    expect(readEntry(store)).toMatchObject({ startedAt });
    expect(actions()).toEqual(["rotation_journal_interrupted", "rotation_journal_begin"]);
  });

  /**
   * A peer may have started its own rotation against a NEWER generation while
   * ours was in flight. Erasing that entry strips the crash protection from an
   * exchange still running elsewhere.
   */
  it("clears only the generation the caller names", () => {
    const store = createStore();
    writeEntry(store, { oldRefreshTokenHash: "gen-peer" });
    const { journal, actions } = buildJournal(store);

    journal.clear("rotation_persisted", "gen-old");
    expect(readEntry(store)).toMatchObject({ oldRefreshTokenHash: "gen-peer" });
    expect(actions()).toEqual([]);

    journal.clear("rotation_persisted", "gen-peer");
    expect(readEntry(store)).toBeNull();
    expect(actions()).toEqual(["rotation_journal_clear"]);
  });

  it("clears any entry when the caller names no generation", () => {
    const store = createStore();
    writeEntry(store, { oldRefreshTokenHash: "gen-peer" });
    const { journal } = buildJournal(store);

    journal.clear("sign_out");

    expect(readEntry(store)).toBeNull();
  });
});
