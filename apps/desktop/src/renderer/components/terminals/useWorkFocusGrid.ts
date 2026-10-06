import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { useLatestCallback } from "../../lib/stableIdentity";
import { cn } from "../ui/cn";
import { makeGridLayoutId, MAX_WORK_GRID_TILES } from "../../lib/workGrid";
import type { WorkFocusCardMark } from "./SessionCard";
import type { WorkFocusQueueItem } from "./useWorkFocusQueueReport";
import {
  focusEvenPages,
  focusFit,
  focusPageColumns,
  focusPageSummary,
  stableFocusOrder,
  wheelScrollsInside,
  type FocusFit,
  type WorkFocusPagerModel,
} from "./WorkFocusGrid";

const EMPTY_FOCUS_PAGE: readonly TerminalSessionSummary[] = [];
/**
 * The Focus grid's state: which chats it shows, in what order, on which page,
 * which tile owns the keyboard, and what the roster (the bottom strip, or the
 * sidebar when it is open) marks. `TerminalsPage` renders the grid from this;
 * the sidebar reports the chats through `setQueueItems`.
 */
export function useWorkFocusGrid({
  enabled,
  sidebarIsRoster,
  projectStateKey,
  rememberSessionPin,
}: {
  /** The Focus grid is on screen. */
  enabled: boolean;
  /** The sessions sidebar is open, so it is the roster and the strip hides. */
  sidebarIsRoster: boolean;
  projectStateKey: string | null;
  rememberSessionPin: (session: TerminalSessionSummary, binding: OpenProjectBinding) => void;
}) {
  /** The chats the Focus grid shows, reported by the sidebar (`workFocusQueue`). */
  const [queueItems, setQueueItems] = useState<readonly WorkFocusQueueItem[]>([]);
  /** The tile that owns the keyboard, once the user picked one. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [requestedPage, setRequestedPage] = useState(0);

  // A chat from another machine renders through that machine's binding.
  useEffect(() => {
    for (const { session, binding } of queueItems) {
      if (binding) rememberSessionPin(session, binding);
    }
  }, [queueItems, rememberSessionPin]);

  // Tiles keep their order: chats that stay keep their place, new ones go last.
  const [order, setOrder] = useState<string[]>([]);
  const queueKey = queueItems.map(({ session }) => session.id).join("\n");
  useEffect(() => {
    setOrder((previous) => {
      const next = stableFocusOrder(previous, queueKey ? queueKey.split("\n") : []);
      return next.length === previous.length && next.every((id, index) => id === previous[index]) ? previous : next;
    });
  }, [queueKey]);
  const sessionsById = useMemo(
    () => new Map(queueItems.map(({ session }) => [session.id, session] as const)),
    [queueItems],
  );
  // The machine each chat lives on, passed straight to its tile. The
  // remembered pin above lands one effect later, and the grid keeps its first
  // render of a tile, so relying on it sent another machine's chat to this one.
  const bindingById = useMemo(
    () => new Map(queueItems.map(({ session, binding }) => [session.id, binding] as const)),
    [queueItems],
  );
  const ordered = useMemo(
    () => order
      .map((id) => sessionsById.get(id))
      .filter((session): session is TerminalSessionSummary => session != null),
    [order, sessionsById],
  );

  // Page size follows the space the grid has: a small window gets fewer,
  // usable tiles per page instead of six cramped ones. Measured on the grid's
  // own box; state changes only when the number of tiles that fit changes.
  // Every tile mounts a full chat, so the hand-made grid's cap still applies,
  // and only the page on screen is mounted.
  const [gridNode, setGridNode] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<FocusFit>({ columns: 3, rows: 2, capacity: MAX_WORK_GRID_TILES });
  useEffect(() => {
    if (!gridNode || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = gridNode.getBoundingClientRect();
      const next = focusFit(rect.width, rect.height, MAX_WORK_GRID_TILES);
      setFit((previous) => (
        previous.columns === next.columns && previous.rows === next.rows && previous.capacity === next.capacity
          ? previous
          : next
      ));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(gridNode);
    return () => observer.disconnect();
  }, [gridNode]);

  // As few pages as fit, with the chats spread evenly across them.
  const pages = useMemo(() => focusEvenPages(ordered, fit.capacity), [fit.capacity, ordered]);
  const pageById = useMemo(() => {
    const map = new Map<string, number>();
    pages.forEach((entries, index) => entries.forEach((session) => map.set(session.id, index)));
    return map;
  }, [pages]);
  // The focused tile decides the page. A new chat or a resize re-spreads the
  // pages, and the tile the user is typing in must not move off screen. Once
  // that chat leaves the grid, the last page the user picked holds.
  const focusedPage = focusedId != null ? pageById.get(focusedId) : undefined;
  const page = focusedPage ?? Math.min(requestedPage, Math.max(0, pages.length - 1));
  const members = pages[page] ?? EMPTY_FOCUS_PAGE;
  const activeId = focusedPage !== undefined ? focusedId : (members[0]?.id ?? null);
  // Keep the picked page in step: when the focused tile moves, its page
  // becomes the picked one, and a focused chat that left the grid lets go, so
  // it cannot pull the view to another page when it comes back.
  useEffect(() => {
    if (focusedId == null) return;
    if (focusedPage === undefined) setFocusedId(null);
    else if (focusedPage !== requestedPage) setRequestedPage(focusedPage);
  }, [focusedId, focusedPage, requestedPage]);

  // A chat that arrives on a page the user is not looking at marks that page
  // until the user goes there. The chats already waiting when the grid opens
  // are the baseline, not arrivals.
  const knownIdsRef = useRef<ReadonlySet<string> | null>(null);
  const [unseenIds, setUnseenIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!enabled) {
      knownIdsRef.current = null;
      setUnseenIds((previous) => (previous.size === 0 ? previous : new Set()));
      return;
    }
    if (order.length === 0 && knownIdsRef.current == null) return;
    const ids = new Set(order);
    const known = knownIdsRef.current;
    knownIdsRef.current = ids;
    setUnseenIds((previous) => {
      const next = new Set([...previous].filter((id) => ids.has(id)));
      if (known) {
        for (const id of ids) {
          if (!known.has(id) && pageById.get(id) !== page) next.add(id);
        }
      }
      for (const session of members) next.delete(session.id);
      return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next;
    });
  }, [enabled, page, pageById, members, order]);

  const [slide, setSlide] = useState<"next" | "previous" | null>(null);
  const goToPage = useLatestCallback((target: number) => {
    const clamped = Math.max(0, Math.min(pages.length - 1, target));
    if (clamped === page) return;
    setSlide(clamped > page ? "next" : "previous");
    setRequestedPage(clamped);
    setFocusedId(pages[clamped]?.[0]?.id ?? null);
  });
  /** Go to a chat's page and focus its tile. False when the chat has no tile. */
  const focusSession = useLatestCallback((sessionId: string): boolean => {
    const target = pageById.get(sessionId);
    if (target === undefined) return false;
    if (target !== page) setSlide(target > page ? "next" : "previous");
    setRequestedPage(target);
    setFocusedId(sessionId);
    return true;
  });

  // A sideways two-finger swipe flips pages, unless something under the pointer
  // scrolls sideways itself (a wide code block, a table).
  const swipeRef = useRef({ accumulated: 0, lockedUntil: 0 });
  const onWheel = useLatestCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (pages.length < 2) return;
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    if (wheelScrollsInside(event.target, event.currentTarget, event.deltaX)) return;
    const swipe = swipeRef.current;
    const now = performance.now();
    if (now < swipe.lockedUntil) return;
    swipe.accumulated += event.deltaX;
    if (Math.abs(swipe.accumulated) < 90) return;
    const direction = swipe.accumulated > 0 ? 1 : -1;
    swipe.accumulated = 0;
    swipe.lockedUntil = now + 450;
    goToPage(page + direction);
  });

  // Side by side first: as few rows as the width allows.
  const columns = focusPageColumns(members.length, fit.columns);
  // One saved layout per SET of chats: the same chats come back exactly as the
  // user arranged them, and a different set starts from the even auto layout
  // instead of squeezing a newcomer into the largest tile. The column count is
  // part of the key, so a window that now fits a different arrangement starts
  // from that arrangement.
  const memberKey = members.map((session) => session.id).join("\n");
  const gridSet = useMemo(() => {
    const sessionIds = memberKey ? memberKey.split("\n") : [];
    const setKey = `${columns}:${[...sessionIds].sort().join(",")}`;
    let hash = 0;
    for (let index = 0; index < setKey.length; index += 1) hash = (hash * 31 + setKey.charCodeAt(index)) >>> 0;
    const id = `focus-${hash.toString(36)}`;
    return { id, layoutId: makeGridLayoutId(projectStateKey, id), sessionIds };
  }, [columns, memberKey, projectStateKey]);

  // With the sessions sidebar open, the sidebar is the roster: other pages'
  // chats name their page, and the pager sits beside the Focus pill.
  const sidebarRoster = enabled && sidebarIsRoster;
  const marks = useMemo(() => {
    if (!sidebarRoster) return null;
    const next = new Map<string, WorkFocusCardMark>();
    pages.forEach((entries, index) => {
      for (const session of entries) {
        next.set(session.id, { page: index, onScreen: index === page, unseen: unseenIds.has(session.id) });
      }
    });
    return next;
  }, [page, pages, sidebarRoster, unseenIds]);
  const pager = useMemo<WorkFocusPagerModel | null>(
    () => (sidebarRoster && pages.length > 1 ? { ...focusPageSummary(pages, page, unseenIds), onPage: goToPage } : null),
    [goToPage, page, pages, sidebarRoster, unseenIds],
  );

  return {
    setQueueItems,
    bindingById,
    members,
    /** The tile that owns the keyboard: the picked one, else the first. */
    activeId,
    /** The tile the user picked, which takes keyboard focus on mount. */
    focusedId,
    setFocusedId,
    focusSession,
    columns,
    gridSet,
    marks,
    pager,
    /** The sidebar's one filled row while the grid shows chats. */
    selectedSessionId: enabled && members.length > 0 ? activeId : null,
    /** Remounts the page box per page, so a new page slides in. */
    pageKey: `focus-page-${page}`,
    /** The page box: measured for fit, swiped to flip, animated on a flip. */
    pageProps: {
      ref: setGridNode,
      className: cn("min-h-0 flex-1", slide && `ade-focus-page-enter-${slide}`),
      onWheel,
      onAnimationEnd: () => setSlide(null),
    },
    /** The bottom strip, or null while the sidebar is the roster. */
    rosterProps: pages.length > 0 && !sidebarIsRoster
      ? { pages, page, activeSessionId: activeId, unseenIds, onPage: goToPage, onChat: focusSession }
      : null,
  };
}
