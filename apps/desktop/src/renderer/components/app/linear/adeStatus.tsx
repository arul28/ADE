import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Cloud, Desktop } from "@phosphor-icons/react";
import type {
  NormalizedLinearIssue,
  OpenProjectBinding,
  PrSummary,
  TerminalSessionSummary,
} from "../../../../shared/types";
import { THIS_MACHINE_ID } from "../../../../shared/machineIdentity";
import { SESSION_TONE_DOT_CLASS } from "../../../../shared/sessionStatusPresentation";
import {
  rootAppStoreApi,
  selectActiveProjectRoot,
  selectActiveProjectStateKey,
  useAppStore,
  useAppStoreApi,
  useRootAppStore,
  workViewStoreForProject,
  type AppState,
} from "../../../state/appStore";
import { buildCrossMachineLaneRows } from "../../../state/crossMachineLanes";
import { machineLabelForMachine, useAdeCloudLaneComputers } from "../../../state/adeCloudLaneIndex";
import { useTabCopyPin } from "../../../state/repositoryScope";
import { listPrsCached } from "../../../lib/prReadCache";
import { openLaneInLanesTabPath, openLaneOnMachinePath } from "../../../lib/laneNavigation";
import { HoverCard } from "../../ui/HoverCard";
import { LaneIcon } from "../../ui/vcsIcons";
import { cn } from "../../ui/cn";
import {
  buildLinearAdeStatusIndex,
  computeLinearIssueAdeStatus,
  type LinearIssueAdeStatus,
  type LinearIssueAdeStatusChat,
  type LinearIssueAdeStatusLane,
} from "./adeStatusIndex";
import { navigateFromLinearPane, stopRowActivation } from "./linearPaneNavigation";

export type { LinearIssueAdeStatus } from "./adeStatusIndex";

/**
 * The ADE column of a Linear issue row and the hook that feeds it. The status
 * itself is computed in `adeStatusIndex.ts` from data the renderer already
 * holds: the tab's lanes and session cache, the cross-machine union (other
 * machines' lanes, sessions and PR rows, kept current by the one app-wide
 * union sync), and the tab copy's PR list. Nothing is fetched per row and
 * nothing polls. A store that has not loaded yet just contributes nothing:
 * the row shows what Linear itself says.
 */

// ── Navigation ───────────────────────────────────────────────────────────────

function lanePath(laneId: string, machineId: string | null | undefined, sessionId?: string | null): string {
  // A lane on another machine opens in this tab's Lanes list, addressed by its
  // machine; the project tab never changes machine to show one lane.
  return machineId ? openLaneOnMachinePath(laneId, machineId, sessionId) : openLaneInLanesTabPath(laneId, sessionId);
}

function openAdeStatusLane(lane: LinearIssueAdeStatusLane, sessionId?: string | null): void {
  navigateFromLinearPane(lanePath(lane.laneId, lane.machineId, sessionId));
}

function openAdeStatusChat(chat: LinearIssueAdeStatusChat): void {
  navigateFromLinearPane(lanePath(chat.laneId, chat.machineId, chat.sessionId));
}

// ── The tab copy's PR rows ───────────────────────────────────────────────────

/**
 * The tab copy's mapped PR rows: one shared, short-cached read (the same
 * entry the chat header and Work tools use) when the Linear pane opens, then
 * kept current by the `prs-updated` push. No GitHub snapshot is read here;
 * a PR ADE has no row for shows Linear's own status. Other machines' rows
 * already ride in the union slices.
 */
function useTabCopyPrRows(): PrSummary[] | null {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  const pin = useTabCopyPin();
  const pinRef = useRef<OpenProjectBinding | null>(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [state, setState] = useState<{ key: string; prs: PrSummary[] } | null>(null);

  useEffect(() => {
    const readPin = pinRef.current;
    const prsApi = window.ade?.prs;
    if (!readPin || !pinKey || typeof prsApi?.listAll !== "function") return undefined;
    let cancelled = false;
    void listPrsCached({ projectRoot, pin: readPin, bindingKey })
      .then((prs) => {
        if (!cancelled) setState({ key: pinKey, prs });
      })
      .catch((error: unknown) => {
        // The row shows Linear's own PR status until the push or a reopen.
        console.warn("[linear] reading the tab's PR rows failed", error);
      });
    let unsubscribe: () => void = () => undefined;
    try {
      if (typeof prsApi.onEvent === "function") {
        unsubscribe = prsApi.onEvent((event) => {
          if (cancelled || event.type !== "prs-updated") return;
          setState({ key: pinKey, prs: event.prs });
        }, readPin);
      }
    } catch (error) {
      // A machine with no live path (ADE Web): the list above still loaded.
      console.warn("[linear] PR updates are off for this machine", error);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bindingKey, pinKey, projectRoot]);

  return state && state.key === pinKey ? state.prs : null;
}

function statusSignature(status: LinearIssueAdeStatus | null): string {
  return status ? JSON.stringify(status) : "";
}

const NO_SESSIONS: TerminalSessionSummary[] | null = null;

/**
 * Read the project's own store. The Linear pane renders from the top bar,
 * above `AppStoreProvider`, where `useAppStore` is the root store: the Work
 * tab's session cache (and the freshest lane list) live in the project's
 * surface store, which the root store only receives on a project switch.
 */
function useProjectSurfaceSlice<T>(projectStateKey: string | null, selector: (state: AppState) => T): T {
  const contextStore = useAppStoreApi();
  const store = contextStore !== rootAppStoreApi ? contextStore : workViewStoreForProject(projectStateKey);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const read = useCallback(() => selectorRef.current(store.getState()), [store]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Memoized index over lanes/sessions/PRs from every connected machine. Returns a stable lookup. */
export function useLinearIssueAdeStatusIndex(): (issue: NormalizedLinearIssue) => LinearIssueAdeStatus | null {
  const projectBinding = useAppStore((state) => state.projectBinding);
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const localLanes = useProjectSurfaceSlice(projectStateKey, (state) => state.lanes);
  const localSessions = useProjectSurfaceSlice(projectStateKey, (state) => (
    projectStateKey ? state.sessionsCacheByProject[projectStateKey] ?? NO_SESSIONS : NO_SESSIONS
  ));
  // Root store: the union is written there only (see `machineEntryForBinding`).
  const machines = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const { computers } = useAdeCloudLaneComputers();
  const tabPrs = useTabCopyPrRows();

  // Results that did not change keep their object across index rebuilds (the
  // union ticks every ~10 s while chats run), so memoized rows stay put.
  const previousResults = useRef(new Map<string, { signature: string; status: LinearIssueAdeStatus | null }>());

  return useMemo(() => {
    const rows = buildCrossMachineLaneRows({
      localLanes: localLanes ?? [],
      machines: machines ?? {},
      activeBinding: projectBinding,
      cloudLaneComputers: computers,
    });
    const activeMachineId = projectBinding?.kind === "remote" ? projectBinding.targetId : THIS_MACHINE_ID;
    const foreignPrsByMachineId = new Map<string, readonly PrSummary[]>();
    for (const entry of Object.values(machines ?? {})) {
      if (entry.machineId === activeMachineId || !entry.prs?.length) continue;
      foreignPrsByMachineId.set(entry.machineId, entry.prs);
    }
    const index = buildLinearAdeStatusIndex({
      rows,
      localSessions,
      tabPrs,
      foreignPrsByMachineId,
      projectBinding,
      labelFor: (row) => machineLabelForMachine({
        hostname: row.binding?.kind === "remote" ? row.binding.hostname ?? null : null,
        machineKey: row.machineId,
        name: row.machineName,
      }, computers),
    });
    const built = new WeakMap<NormalizedLinearIssue, LinearIssueAdeStatus | null>();
    const previous = previousResults.current;
    if (previous.size > 2000) previous.clear();
    return (issue: NormalizedLinearIssue) => {
      if (built.has(issue)) return built.get(issue) ?? null;
      const next = computeLinearIssueAdeStatus(index, issue);
      const signature = statusSignature(next);
      const kept = previous.get(issue.id);
      const status = kept && kept.signature === signature ? kept.status : next;
      if (!kept || kept.status !== status) previous.set(issue.id, { signature, status });
      built.set(issue, status);
      return status;
    };
  }, [computers, localLanes, localSessions, machines, projectBinding, tabPrs]);
}

// ── The cell ─────────────────────────────────────────────────────────────────

function LiveDot({ state, className }: { state: "working" | "needs_you"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block h-[5px] w-[5px] rounded-full",
        state === "needs_you" ? SESSION_TONE_DOT_CLASS.amber : SESSION_TONE_DOT_CLASS.blue,
        state === "working" && "motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

function MachineGlyph({ lane, size = 10 }: { lane: LinearIssueAdeStatusLane; size?: number }) {
  if (lane.machineLabel == null) return null;
  return lane.cloud
    ? <Cloud size={size} weight="bold" aria-hidden className="shrink-0" />
    : <Desktop size={size} weight="bold" aria-hidden className="shrink-0" />;
}

function cellLabel(status: LinearIssueAdeStatus): string {
  const parts: string[] = [];
  parts.push(status.lanes.length === 1 ? `Lane ${status.lanes[0]!.laneName}` : `${status.lanes.length} lanes`);
  const foreign = status.lanes.find((lane) => lane.machineLabel);
  if (foreign && status.lanes.length === 1) parts.push(`on ${foreign.machineLabel}`);
  if (status.needsInput) parts.push("a chat needs you");
  else if (status.runningChats > 0) parts.push(status.runningChats === 1 ? "1 chat working" : `${status.runningChats} chats working`);
  return parts.join(", ");
}

function StatusCard({ status }: { status: LinearIssueAdeStatus }) {
  const chats = status.chats;
  return (
    <div className="overflow-hidden rounded-lg border border-fg/[0.10] bg-[color:var(--color-popup-bg)] py-1 text-[12px] shadow-[var(--shadow-popup)]">
      {status.lanes.map((lane) => {
        const laneChats = chats.filter((chat) => chat.laneId === lane.laneId && chat.machineId === lane.machineId);
        const offline = !lane.online;
        return (
          <div key={`${lane.machineId ?? "tab"}:${lane.laneId}`} className="px-1">
            <button
              type="button"
              disabled={offline}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                offline ? "cursor-default opacity-60" : "hover:bg-fg/[0.05]",
              )}
              title={offline ? `${lane.machineLabel ?? "Its computer"} is offline` : "Open lane"}
              onClick={() => openAdeStatusLane(lane)}
            >
              <LaneIcon size={13} className="text-muted-fg/70" />
              <span className="min-w-0 flex-1 truncate text-fg/90">{lane.laneName}</span>
              {lane.machineLabel ? (
                <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 text-[11px] text-muted-fg/60">
                  <MachineGlyph lane={lane} />
                  <span className="truncate">{lane.machineLabel}</span>
                  {offline ? <span className="shrink-0">offline</span> : null}
                </span>
              ) : null}
            </button>
            {laneChats.map((chat) => (
              <button
                key={chat.sessionId}
                type="button"
                disabled={!chat.online}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md py-1 pl-[30px] pr-2 text-left transition-colors",
                  chat.online ? "hover:bg-fg/[0.05]" : "cursor-default opacity-60",
                )}
                title={chat.kind === "chat" ? "Open chat" : "Open CLI session"}
                onClick={() => openAdeStatusChat(chat)}
              >
                <LiveDot state={chat.state} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-fg/80">{chat.title}</span>
                <span className={cn("shrink-0 text-[11px]", chat.state === "needs_you" ? "text-amber-500 dark:text-amber-300" : "text-muted-fg/60")}>
                  {chat.state === "needs_you" ? "Needs you" : "Working"}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The ADE column of a Linear issue row: a lane glyph (with the machine when
 * the lane is not on this computer), a live dot while a chat works (amber when
 * one waits for the person). Click opens the chat that needs you, the one
 * working chat, or the lane; hover lists every lane and chat.
 */
export function LinearIssueAdeStatusCell({ status }: { status: LinearIssueAdeStatus | null }): JSX.Element | null {
  const primaryAction = useCallback(() => {
    if (!status) return;
    const chats = status.chats.filter((chat) => chat.online);
    const waiting = chats.find((chat) => chat.state === "needs_you");
    if (waiting) return openAdeStatusChat(waiting);
    if (chats.length === 1) return openAdeStatusChat(chats[0]!);
    const lane = status.lanes.find((candidate) => candidate.online);
    if (lane) openAdeStatusLane(lane);
  }, [status]);

  if (!status || status.lanes.length === 0) return null;
  const foreign = status.lanes.length === 1 ? status.lanes[0]!.machineLabel ? status.lanes[0]! : null : null;
  const allOffline = status.lanes.every((lane) => !lane.online);
  const dotState = status.needsInput ? "needs_you" : status.runningChats > 0 ? "working" : null;
  const label = cellLabel(status);

  return (
    <HoverCard className="inline-flex shrink-0" label={label} width={320} content={<StatusCard status={status} />}>
      <button
        type="button"
        aria-label={label}
        disabled={allOffline}
        data-linear-ade-status=""
        className={cn(
          "inline-flex h-[22px] max-w-[96px] shrink-0 items-center gap-1 rounded-md px-1 text-muted-fg/65 outline-none transition-colors",
          "hover:bg-fg/[0.06] hover:text-fg focus-visible:bg-fg/[0.06] focus-visible:text-fg",
          allOffline && "opacity-55",
        )}
        onClick={(event) => {
          event.stopPropagation();
          primaryAction();
        }}
        onKeyDown={stopRowActivation}
      >
        <span className="relative grid place-items-center">
          <LaneIcon size={13} />
          {dotState ? (
            <LiveDot
              state={dotState}
              className="absolute -right-[2px] -top-[1px] ring-[1.5px] ring-[color:var(--color-bg)]"
            />
          ) : null}
        </span>
        {status.lanes.length > 1 ? <span className="text-[11px] tabular-nums">{status.lanes.length}</span> : null}
        {foreign ? <MachineGlyph lane={foreign} /> : null}
      </button>
    </HoverCard>
  );
}
