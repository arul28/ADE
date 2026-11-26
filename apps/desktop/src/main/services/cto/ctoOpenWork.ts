import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CTO_OPEN_WORK_MAX_DONE,
  CTO_OPEN_WORK_MAX_OPEN,
  type CtoOpenWorkItem,
  type CtoOpenWorkLink,
  type CtoOpenWorkOwner,
  type CtoUpdateOpenWorkArgs,
} from "../../../shared/types/cto";
import { AdeExpectedError } from "../../../shared/expectedError";
import { clipText, nowIso, redactSecrets, writeTextAtomic } from "../shared/utils";
import { readFileOrEmpty } from "./ctoNoteText";

/**
 * The CTO's open work: `.ade/cto/open-work.json`, the edits the CTO and the
 * person make to it, and the links that close an item when its chat or PR is
 * done. The memory service owns one of these and passes its calls through.
 */

const OPEN_WORK_TEXT_MAX_CHARS = 300;
const OPEN_WORK_OUTCOME_MAX_CHARS = 120;
const OPEN_WORK_TITLE_MAX_CHARS = 60;
/** Done items shown in the injected list, newest first. */
const OPEN_WORK_INJECTED_DONE = 5;

function normalizeOpenWorkLink(value: unknown): CtoOpenWorkLink | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "pr") {
    const number = Number(record.number);
    return Number.isInteger(number) && number > 0 ? { kind: "pr", number } : null;
  }
  if (record.kind === "chat") {
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    if (!sessionId) return null;
    const machineId = typeof record.machineId === "string" ? record.machineId.trim() : "";
    return machineId ? { kind: "chat", sessionId, machineId } : { kind: "chat", sessionId };
  }
  return null;
}

/** What a linked item's chat or PR looks like right now, as far as this machine knows. */
export type CtoLinkedWorkResolver = {
  /** The PR's state on the repo ("open", "draft", "merged", "closed"), or null when unknown. */
  prState: (number: number) => string | null;
  /**
   * The chat as far as this machine can tell, or null when it cannot (a
   * machine it has not read): done (settled, archived or ended), when it last
   * came to rest after a clean turn, and its last status line. A chat's live
   * state comes from its runtime, so this may answer later.
   */
  chatState: (link: Extract<CtoOpenWorkLink, { kind: "chat" }>) =>
    | CtoLinkedChatState
    | null
    | Promise<CtoLinkedChatState | null>;
};

export type CtoLinkedChatState = { done: boolean; restedAt: string | null; statusLine: string | null };

/**
 * The outcome line for a linked item whose chat or PR has closed, or null
 * while it is still going. A chat counts as done when it ended, or when it
 * came to rest after the item was linked: a chat that was already resting
 * when the CTO linked it has not done that work yet.
 */
async function linkedWorkOutcome(
  item: Pick<CtoOpenWorkItem, "link" | "createdAt">,
  resolver: CtoLinkedWorkResolver,
): Promise<string | null> {
  const link = item.link;
  if (!link) return null;
  if (link.kind === "pr") {
    const state = resolver.prState(link.number);
    // The row already shows the PR number beside the outcome.
    if (state === "merged") return "Merged";
    if (state === "closed") return "Closed without merging";
    return null;
  }
  const chat = await resolver.chatState(link);
  if (!chat) return null;
  const restedSince = chat.restedAt != null && Date.parse(chat.restedAt) > Date.parse(item.createdAt);
  if (!chat.done && !restedSince) return null;
  return chat.statusLine ? `Done: ${chat.statusLine}` : "Done";
}

function newWorkId(): string {
  return `w-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOpenWorkItem(value: unknown): CtoOpenWorkItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!id || !text) return null;
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : nowIso();
  const doneAt = typeof record.doneAt === "string" && record.doneAt.trim() ? record.doneAt : null;
  const title = optionalText(record.title);
  const link = normalizeOpenWorkLink(record.link);
  const outcome = optionalText(record.outcome);
  const closedBy = record.closedBy === "auto" || record.closedBy === "user" || record.closedBy === "cto" ? record.closedBy : null;
  return {
    id,
    text,
    createdAt,
    doneAt,
    addedBy: record.addedBy === "user" ? "user" : "cto",
    ...(title ? { title } : {}),
    ...(record.owner === "user" || record.owner === "cto" ? { owner: record.owner } : {}),
    ...(link ? { link } : {}),
    ...(outcome ? { outcome } : {}),
    ...(closedBy ? { closedBy } : {}),
  };
}

/** Open items oldest first (a checklist), then finished ones newest first. */
function orderOpenWork(items: readonly CtoOpenWorkItem[]): CtoOpenWorkItem[] {
  const open = items.filter((item) => !item.doneAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const done = items.filter((item) => item.doneAt).sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  return [...open, ...done];
}

export type CtoOpenWorkResult =
  | { ok: true; item: CtoOpenWorkItem }
  | { ok: false; error: string };

type Logger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
};

type CtoOpenWorkArgs = {
  /** `.ade/cto/open-work.json`. */
  path: string;
  logger?: Logger | null;
  /** After the list changes, e.g. so the account copy is saved again. */
  onChanged?: (() => void) | null;
  /** Linked items closed themselves (their chat or PR finished). */
  onLinkedWorkClosed?: ((count: number) => void) | null;
};

export function createCtoOpenWork(args: CtoOpenWorkArgs) {
  const openWorkPath = args.path;
  const logger = args.logger ?? null;
  const warn = (message: string, error: unknown, meta?: Record<string, unknown>): void => {
    logger?.warn(message, {
      ...(meta ?? {}),
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const readOpenWork = (): CtoOpenWorkItem[] => {
    const raw = readFileOrEmpty(openWorkPath);
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as { items?: unknown };
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      return orderOpenWork(items.map(normalizeOpenWorkItem).filter((item): item is CtoOpenWorkItem => item != null));
    } catch (error) {
      // Moved aside, not left to be overwritten: the next write would replace
      // the only copy of the list, and a hand edit gone wrong is worth reading.
      const asidePath = `${openWorkPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(openWorkPath, asidePath);
        warn("cto_memory.open_work_unreadable", error, { movedTo: asidePath });
      } catch (renameError) {
        warn("cto_memory.open_work_unreadable", error, {
          moveFailed: renameError instanceof Error ? renameError.message : String(renameError),
        });
      }
      return [];
    }
  };

  const writeOpenWork = (items: readonly CtoOpenWorkItem[]): void => {
    const ordered = orderOpenWork(items);
    // Finished items past the cap go oldest first; open ones are never dropped.
    const open = ordered.filter((item) => !item.doneAt);
    const done = ordered.filter((item) => item.doneAt).slice(0, CTO_OPEN_WORK_MAX_DONE);
    writeTextAtomic(openWorkPath, `${JSON.stringify({ version: 1, items: [...open, ...done] }, null, 2)}\n`);
    args.onChanged?.();
  };

  /** The open-work file as it is on disk, for the account copy; null when there is none. */
  const readOpenWorkText = (): string | null => {
    try {
      return fs.readFileSync(openWorkPath, "utf8");
    } catch {
      return null;
    }
  };

  /** Puts a copy's open-work file in place; null removes this machine's list. */
  const replaceOpenWorkText = (text: string | null): void => {
    if (text == null) {
      fs.rmSync(openWorkPath, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(openWorkPath), { recursive: true });
    writeTextAtomic(openWorkPath, text);
  };

  const trackWork = (
    text: string,
    addedBy: CtoOpenWorkItem["addedBy"] = "cto",
    extra: { title?: string | null; owner?: CtoOpenWorkOwner | null; link?: CtoOpenWorkLink | null } = {},
  ): CtoOpenWorkResult => {
    const normalized = clipText(redactSecrets(text.replace(/\s+/g, " ").trim()), OPEN_WORK_TEXT_MAX_CHARS);
    if (!normalized.length) return { ok: false, error: "Say what the work is." };
    const title = extra.title
      ? clipText(redactSecrets(extra.title.replace(/\s+/g, " ").trim()), OPEN_WORK_TITLE_MAX_CHARS)
      : "";
    const link = extra.link ? normalizeOpenWorkLink(extra.link) : null;
    const items = readOpenWork();
    if (items.filter((item) => !item.doneAt).length >= CTO_OPEN_WORK_MAX_OPEN) {
      return { ok: false, error: `Open work is full (${CTO_OPEN_WORK_MAX_OPEN} items). Finish or remove one first.` };
    }
    const existingIds = new Set(items.map((item) => item.id));
    let id = newWorkId();
    while (existingIds.has(id)) id = newWorkId();
    const item: CtoOpenWorkItem = {
      id,
      text: normalized,
      createdAt: nowIso(),
      doneAt: null,
      addedBy,
      owner: extra.owner ?? "cto",
      ...(title && title !== normalized ? { title } : {}),
      ...(link ? { link } : {}),
    };
    writeOpenWork([...items, item]);
    return { ok: true, item };
  };

  const updateItem = (
    id: string,
    change: (item: CtoOpenWorkItem) => CtoOpenWorkItem | null,
  ): CtoOpenWorkResult => {
    const key = id.trim();
    const items = readOpenWork();
    const current = items.find((item) => item.id === key);
    if (!current) return { ok: false, error: `No open-work item has id "${key}".` };
    const updated = change(current);
    if (!updated) return { ok: false, error: `Item "${key}" cannot change that way.` };
    writeOpenWork(items.map((item) => (item.id === key ? updated : item)));
    return { ok: true, item: updated };
  };

  const finishWork = (id: string, outcome?: string | null, closedBy: "cto" | "user" = "cto"): CtoOpenWorkResult =>
    updateItem(id, (item) => {
      if (item.doneAt) return item;
      const note = outcome?.replace(/\s+/g, " ").trim();
      return {
        ...item,
        ...(note ? { outcome: clipText(redactSecrets(note), OPEN_WORK_OUTCOME_MAX_CHARS) } : {}),
        doneAt: nowIso(),
        closedBy,
      };
    });

  const reopenWork = (id: string): CtoOpenWorkResult => {
    if (readOpenWork().filter((item) => !item.doneAt).length >= CTO_OPEN_WORK_MAX_OPEN) {
      return { ok: false, error: `Open work is full (${CTO_OPEN_WORK_MAX_OPEN} items). Finish or remove one first.` };
    }
    // Reopened by hand, it stops closing itself: the link said done once already.
    return updateItem(id, ({ outcome: _outcome, closedBy: _closedBy, link: _link, ...item }) => ({ ...item, doneAt: null }));
  };

  let linkedWorkResolver: CtoLinkedWorkResolver | null = null;
  let linkedWorkRun: Promise<number> | null = null;
  /**
   * Close every open item whose linked chat or PR has closed, with an outcome
   * line. Runs at the start of each CTO turn, on each read of the list (the
   * side panel, Settings) and when PRs change, so a merged PR's item is done
   * the next time anyone looks. Local reads only (a chat on another machine
   * answers from the last read of it); writes only when something closed.
   * One run at a time: a caller that finds one running joins it.
   */
  const reconcileLinkedWork = (): Promise<number> => {
    if (linkedWorkRun) return linkedWorkRun;
    const run = (async () => {
      const resolver = linkedWorkResolver;
      if (!resolver) return 0;
      const closures = new Map<string, string>();
      for (const item of readOpenWork()) {
        if (item.doneAt || !item.link) continue;
        try {
          const outcome = await linkedWorkOutcome(item, resolver);
          if (outcome) closures.set(item.id, clipText(redactSecrets(outcome), OPEN_WORK_OUTCOME_MAX_CHARS));
        } catch (error) {
          warn("cto_memory.linked_work_check_failed", error, { id: item.id });
        }
      }
      if (!closures.size) return 0;
      // Read again: the person may have finished, reopened or removed an item
      // while the checks ran. Close only what is still open and still linked.
      const doneAt = nowIso();
      let closed = 0;
      const next = readOpenWork().map((item) => {
        const outcome = closures.get(item.id);
        if (!outcome || item.doneAt || !item.link) return item;
        closed += 1;
        return { ...item, doneAt, outcome, closedBy: "auto" as const };
      });
      if (!closed) return 0;
      writeOpenWork(next);
      logger?.info?.("cto_memory.linked_work_closed", { count: closed });
      args.onLinkedWorkClosed?.(closed);
      return closed;
    })()
      .catch((error) => {
        warn("cto_memory.linked_work_reconcile_failed", error);
        return 0;
      })
      .finally(() => {
        if (linkedWorkRun === run) linkedWorkRun = null;
      });
    linkedWorkRun = run;
    return run;
  };

  /** Open items' chats on other machines, for the machine reads that report on them. */
  const listLinkedRemoteChats = (): Array<{ machineId: string; sessionId: string }> =>
    readOpenWork().flatMap((item) => (!item.doneAt && item.link?.kind === "chat" && item.link.machineId
      ? [{ machineId: item.link.machineId, sessionId: item.link.sessionId }]
      : []));

  /** Late-bound: the PR and session services exist after this one. */
  const setLinkedWorkResolver = (resolver: CtoLinkedWorkResolver | null): void => {
    linkedWorkResolver = resolver;
  };

  const removeWork = (id: string): CtoOpenWorkResult => {
    const key = id.trim();
    const items = readOpenWork();
    const current = items.find((item) => item.id === key);
    if (!current) return { ok: false, error: `No open-work item has id "${key}".` };
    writeOpenWork(items.filter((item) => item.id !== key));
    return { ok: true, item: current };
  };

  /** The settings and panel path: the person's own edits to the list. */
  const updateOpenWork = (change: CtoUpdateOpenWorkArgs): void => {
    const result = change.op === "add"
      ? trackWork(change.text, "user", { owner: change.owner ?? "cto" })
      : change.op === "complete"
        ? finishWork(change.id, null, "user")
        : change.op === "reopen"
          ? reopenWork(change.id)
          : removeWork(change.id);
    if (!result.ok) throw new AdeExpectedError(result.error, "user");
  };

  /** The injected "## Open work" lines: open items first, then the newest finished ones. */
  const contextLines = (): string[] => {
    const items = readOpenWork();
    const open = items.filter((item) => !item.doneAt);
    const done = items.filter((item) => item.doneAt).slice(0, OPEN_WORK_INJECTED_DONE);
    const describe = (item: CtoOpenWorkItem): string => {
      const title = item.title ? `${item.title} — ` : "";
      const link = item.link
        ? item.link.kind === "pr"
          ? ` [PR #${item.link.number}]`
          : ` [chat ${item.link.sessionId}${item.link.machineId ? ` on ${item.link.machineId}` : ""}]`
        : "";
      return `${title}${item.text}${link}`;
    };
    return [
      ...open.map((item) => `- [ ] ${item.id} (${(item.owner ?? "cto") === "user" ? "waiting on the person" : "yours"}): ${describe(item)}`),
      ...done.map((item) => `- [x] ${item.id}: ${describe(item)} (done${item.outcome ? `: ${item.outcome}` : ""}${item.closedBy === "auto" ? ", closed by its link" : ""})`),
    ];
  };

  return {
    readOpenWork,
    readOpenWorkText,
    replaceOpenWorkText,
    trackWork,
    finishWork,
    updateOpenWork,
    reconcileLinkedWork,
    setLinkedWorkResolver,
    listLinkedRemoteChats,
    contextLines,
  };
}
