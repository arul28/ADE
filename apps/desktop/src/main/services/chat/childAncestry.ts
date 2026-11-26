import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../state/durableFile";

/**
 * Where a subagent reports when the chat that started it is gone: the nearest
 * live chat above it, else the project's CTO.
 *
 * A deleted chat's row and state go with it, and with them the only record of
 * who started it. Each delete leaves one small link (its own parent, and its
 * title) in a machine-local file, so a child that finishes after its parent
 * was deleted can still find the chat above it. Local on purpose: the links
 * name deleted chats, and only this machine's chats walk them.
 */

const LINK_TTL_MS = 90 * 24 * 60 * 60_000;
const MAX_LINKS = 500;

type DeletedParentLink = { parentSessionId: string; title: string; at: number };

export type LiveAncestor = { sessionId: string; goneTitle: string };

export type ChildAncestryDeps = {
  /** The machine-local JSON file the links live in. */
  linksFilePath: string;
  /** A chat that would see a report now: here and not put away, or a parent elsewhere the router reaches. */
  takesReports(sessionId: string): boolean;
  /** The chat's own parent, from its live or persisted state ("" when none). */
  ownParentOf(sessionId: string): string;
  /** The chat's title, when it still exists here. */
  titleOf(sessionId: string): string;
  /** CTO threads here, loaded ones first. Read only when nothing above the child is live. */
  ctoCandidates(): Iterable<string>;
  logger: { warn(event: string, meta?: Record<string, unknown>): void };
  now?: () => number;
};

export function createChildAncestry(deps: ChildAncestryDeps) {
  const now = deps.now ?? Date.now;

  /** The links still in date: an expired one is ignored at once, not when the next delete prunes it. */
  const readLinks = (): Record<string, DeletedParentLink> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(deps.linksFilePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const at = now();
      return Object.fromEntries(Object.entries(parsed as Record<string, DeletedParentLink>).filter(([, link]) =>
        typeof link?.parentSessionId === "string"
        && typeof link.at === "number"
        && at - link.at < LINK_TTL_MS));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        deps.logger.warn("agent_chat.deleted_parent_links_read_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {};
    }
  };

  /** Remember a deleted chat's own parent ("" for a top-level chat) and title. */
  const rememberDeleted = (sessionId: string, parentSessionId: string, title: string): void => {
    const at = now();
    const kept = Object.entries(readLinks())
      .filter(([id]) => id !== sessionId)
      .sort((left, right) => right[1].at - left[1].at)
      .slice(0, MAX_LINKS - 1);
    fs.mkdirSync(path.dirname(deps.linksFilePath), { recursive: true });
    writeFileAtomic(
      deps.linksFilePath,
      JSON.stringify(Object.fromEntries([[sessionId, { parentSessionId, title, at }], ...kept])),
    );
  };

  /** The title the gone chat had, from its link or its row. */
  const goneTitleOf = (sessionId: string, links = readLinks()): string =>
    links[sessionId]?.title?.trim() || deps.titleOf(sessionId);

  /** True when `childSessionId` is above `sessionId`: reporting there would loop back. */
  const isBelow = (sessionId: string, childSessionId: string, links: Record<string, DeletedParentLink>): boolean => {
    const seen = new Set<string>([sessionId]);
    let cursor = sessionId;
    for (;;) {
      const next = links[cursor]?.parentSessionId?.trim() || deps.ownParentOf(cursor);
      if (!next || seen.has(next)) return false;
      if (next === childSessionId) return true;
      seen.add(next);
      cursor = next;
    }
  };

  const projectCto = (
    exclude: ReadonlySet<string>,
    childSessionId: string,
    links: Record<string, DeletedParentLink>,
  ): string | null => {
    for (const id of deps.ctoCandidates()) {
      if (exclude.has(id) || !deps.takesReports(id) || isBelow(id, childSessionId, links)) continue;
      return id;
    }
    return null;
  };

  /**
   * The closest chat above `goneParentSessionId` that takes reports: its
   * parent, that chat's parent, and so on up to the CTO. A deleted chat is
   * walked through its link, a put-away one through its own state. With
   * nothing live above it, the project's CTO. Null when there is none.
   */
  const nearestLiveAncestor = (goneParentSessionId: string, childSessionId: string): LiveAncestor | null => {
    const links = readLinks();
    const seen = new Set<string>([childSessionId, goneParentSessionId]);
    let goneTitle = goneTitleOf(goneParentSessionId, links);
    let cursor = goneParentSessionId;
    // No depth limit: every step adds an id to `seen`, so a loop ends it.
    for (;;) {
      const next = links[cursor]?.parentSessionId?.trim() || deps.ownParentOf(cursor);
      if (!next || seen.has(next)) break;
      seen.add(next);
      if (deps.takesReports(next)) return { sessionId: next, goneTitle };
      goneTitle ||= links[next]?.title || "";
      cursor = next;
    }
    const cto = projectCto(seen, childSessionId, links);
    return cto ? { sessionId: cto, goneTitle } : null;
  };

  return { rememberDeleted, nearestLiveAncestor, goneTitleOf };
}

/** The line a relinked report opens with, so the new parent knows why it hears from this chat. */
export function relinkedReportNote(goneTitle: string): string {
  return goneTitle
    ? `It reports to you because "${goneTitle}", the chat that started it, is gone.`
    : "It reports to you because the chat that started it is gone.";
}
