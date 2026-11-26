import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatCircleDots, Terminal } from "@phosphor-icons/react";
import type { LaneBranchActiveWorkItem, OpenProjectBinding, TerminalSessionSummary, TerminalToolType } from "../../../../shared/types";
import { chatToolProvider, sessionActiveKind, type SessionActiveKind } from "../../../../shared/sessionSpawnNesting";
import { providerStopModeSupport } from "../../../../shared/chatStopModes";
import { THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import { canonicalInputFromSummary, sessionCanonicalUiState, sessionIsMidFlight } from "../../../lib/terminalAttention";
import { primarySessionLabel } from "../../../lib/sessions";
import { extractError } from "../../../lib/format";
import { useMachineEntryForBinding, usePinTargetsTab } from "../../../state/crossMachineLanes";
import { Dialog } from "../../ui/dialog/Dialog";
import { Banner, InlineErrorNotice } from "../../ui/notice";
import { ToolLogo } from "../../terminals/ToolLogos";
import { COLORS, SANS_FONT } from "../laneDesignTokens";

/** What one open session in the lane is doing, for the dialog. */
export type LaneActiveWorkRow = {
  id: string;
  title: string;
  toolType: string | null;
  kind: SessionActiveKind;
  ptyId: string | null;
  /**
   * `running`: a chat turn or its background jobs are working; it will change
   * on its own. `needs_you`: waiting on the person. `open`: nothing ADE can
   * see is working. A terminal ADE cannot see into reads `open` too.
   */
  state: "running" | "needs_you" | "open";
};

function sessionIsWorking(session: TerminalSessionSummary): boolean {
  if (session.ptyExitPending) return true;
  const input = canonicalInputFromSummary(session);
  // Jobs keep using the worktree even after the chat is marked settled.
  return (input.backgroundWork?.workingCount ?? 0) > 0 || sessionIsMidFlight(input);
}

/**
 * Open sessions in a lane, classified the way the Work tab reads them, plus
 * any the host reported that the Work roster does not list (a side chat).
 */
export function classifyLaneActiveWork(
  sessions: readonly TerminalSessionSummary[],
  reported: readonly LaneBranchActiveWorkItem[] = [],
): LaneActiveWorkRow[] {
  const rank = { running: 0, needs_you: 1, open: 2 } as const;
  const rows = sessions
    .filter((session) => !session.endedAt && (!session.archivedAt || session.runtimeState === "running" || sessionIsWorking(session)))
    .map((session): LaneActiveWorkRow => ({
      id: session.id,
      title: primarySessionLabel(session),
      toolType: session.toolType ?? null,
      kind: sessionActiveKind(session.toolType),
      ptyId: session.ptyId ?? null,
      state: session.archivedAt || sessionIsWorking(session)
        ? "running"
        : sessionCanonicalUiState(canonicalInputFromSummary(session)).phase === "needs_you" ? "needs_you" : "open",
    }));
  const listed = new Set(rows.map((row) => row.id));
  for (const item of reported) {
    if (listed.has(item.id)) continue;
    rows.push({ id: item.id, title: item.title, toolType: item.toolType ?? null, kind: item.kind, ptyId: null, state: "open" });
  }
  return rows.sort((a, b) => rank[a.state] - rank[b.state]);
}

/** How long "Stop and switch" waits for the stopped work to actually end. */
const STOP_CONFIRM_TIMEOUT_MS = 8_000;
const STOP_CONFIRM_POLL_MS = 400;

/** How often "Wait, then switch" re-reads the lane when no change event arrives. */
const WAIT_BACKSTOP_MS = 4_000;

const STATE_LABEL: Record<LaneActiveWorkRow["state"], string> = {
  running: "Running",
  needs_you: "Waiting for you",
  open: "Open",
};

const EMPTY_REPORTED_WORK: readonly LaneBranchActiveWorkItem[] = [];

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Says what is running in a lane before its branch changes, and offers the
 * ways through: wait for it, stop it, go ahead anyway, or cancel.
 *
 * Every read and every stop goes to the lane's own machine (`pin`), and the
 * caller's `onContinue` switches there too.
 */
export function LaneActiveWorkDialog({
  open,
  laneId,
  laneName,
  pin,
  targetLabel,
  reportedWork = EMPTY_REPORTED_WORK,
  onContinue,
  onCancel,
}: {
  open: boolean;
  laneId: string;
  /** Already a display name (`laneDisplayName`). */
  laneName: string;
  /** The lane's machine. */
  pin: OpenProjectBinding;
  /** What happens next, e.g. the branch name: "Switch to {targetLabel}". */
  targetLabel: string;
  /** What the host said is open, when the caller has it; rows the Work list leaves out still show. */
  reportedWork?: readonly LaneBranchActiveWorkItem[];
  /** Run the switch with active work acknowledged. */
  onContinue: () => void;
  onCancel: () => void;
}) {
  const machineEntry = useMachineEntryForBinding(pin);
  const onTabMachine = usePinTargetsTab(pin);
  // Read mid-sentence ("on this computer"), so ADE's own machine is lower case.
  const rawMachineName = machineEntry?.machineName ?? (onTabMachine ? THIS_MACHINE_NAME : null);
  const machineName = rawMachineName === THIS_MACHINE_NAME ? THIS_MACHINE_NAME.toLowerCase() : rawMachineName;
  const [rows, setRows] = useState<LaneActiveWorkRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"choose" | "waiting" | "stopping">("choose");
  const [stopErrors, setStopErrors] = useState<Map<string, string>>(() => new Map());
  const unconfirmedTerminals = useRef(new Map<string, string>());
  // Read through refs so a rebuilt pin or callback with the same meaning
  // restarts nothing.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;
  const continuedRef = useRef(false);
  // False once the dialog closes: a stop that finishes later must not switch.
  const aliveRef = useRef(false);
  const openGeneration = useRef(0);
  // Reads can answer out of order; only the newest one counts.
  const readSeqRef = useRef(0);
  const reportedRef = useRef(reportedWork);
  reportedRef.current = reportedWork;

  /** Every open session in the lane, from its machine. No page limit: an old running chat must not hide behind newer ones. */
  const readRows = useCallback(async (): Promise<LaneActiveWorkRow[]> => {
    const sessions = await window.ade.sessions.list(
      { laneId, limit: null, includeArchived: false, openOnly: true },
      pinRef.current,
      { authoritative: true },
    );
    return classifyLaneActiveWork(sessions.filter((session) => session.laneId === laneId), reportedRef.current);
  }, [laneId]);

  const load = useCallback(async () => {
    const seq = ++readSeqRef.current;
    try {
      const next = await readRows();
      if (seq !== readSeqRef.current) return;
      setRows(next);
      setLoadError(null);
    } catch (error) {
      if (seq !== readSeqRef.current) return;
      setLoadError(extractError(error));
    }
  }, [readRows]);

  // Read the lane while open, and again whenever a session on its machine
  // changes, so "Waiting" sees work finish without polling.
  const pinKey = pin.key;
  useEffect(() => {
    if (!open) return undefined;
    aliveRef.current = true;
    continuedRef.current = false;
    setRows(null);
    setLoadError(null);
    setMode("choose");
    setStopErrors(new Map());
    unconfirmedTerminals.current.clear();
    void load();
    let timer: number | null = null;
    const unsubscribe = window.ade.sessions.onChanged(() => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void load(); }, 300);
    }, pinRef.current);
    return () => {
      aliveRef.current = false;
      openGeneration.current++;
      readSeqRef.current++;
      if (timer != null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [laneId, load, open, pinKey]);

  const running = useMemo(() => rows?.filter((row) => row.state === "running") ?? [], [rows]);

  const proceed = useCallback(() => {
    if (continuedRef.current || !aliveRef.current) return;
    continuedRef.current = true;
    onContinueRef.current();
  }, []);

  // Waiting ends by itself once nothing in the lane is running.
  useEffect(() => {
    if (mode === "waiting" && !loadError && rows && running.length === 0) proceed();
  }, [loadError, mode, proceed, rows, running.length]);

  // A turn can end without a session change event; while the person waits,
  // read the lane again now and then as a backstop. Only while waiting.
  useEffect(() => {
    if (!open || mode !== "waiting") return undefined;
    const interval = window.setInterval(() => { void load(); }, WAIT_BACKSTOP_MS);
    return () => window.clearInterval(interval);
  }, [load, mode, open]);

  const stopAndContinue = useCallback(async () => {
    setMode("stopping");
    setStopErrors(new Map());
    const stopPin = pinRef.current;
    const generation = openGeneration.current;
    const isCurrent = () => aliveRef.current && openGeneration.current === generation;
    const errors = new Map(unconfirmedTerminals.current);
    await Promise.all(running.map(async ({ id, kind, ptyId, toolType }) => {
      try {
        if (kind === "chat") {
          const mode = providerStopModeSupport(chatToolProvider(toolType), "stop_and_clear_and_background").supported
            ? "stop_and_clear_and_background" : "stop_and_clear";
          await window.ade.agentChat.interrupt({ sessionId: id, mode }, stopPin);
        } else if (ptyId) {
          const result = await window.ade.pty.dispose({ ptyId, sessionId: id, confirmProcessExit: true }, stopPin);
          if (result?.processTreeExited === true) {
            errors.delete(id);
          } else {
            errors.set(id, "ADE couldn’t confirm that the terminal exited.");
          }
        } else {
          errors.set(id, "ADE couldn’t find the running terminal.");
        }
      } catch (error) {
        errors.set(id, extractError(error));
      }
    }));
    if (!isCurrent()) return;
    for (const { id, kind } of running) {
      if (kind === "chat") continue;
      const failure = errors.get(id);
      if (failure) unconfirmedTerminals.current.set(id, failure);
      else unconfirmedTerminals.current.delete(id);
    }
    // Check the whole lane, including sessions that began working after Stop.
    // Terminal disposal has a separate exit receipt because the roster can forget a live process.
    const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
    while (errors.size === 0 && isCurrent()) {
      try {
        const latest = await readRows();
        if (!isCurrent()) return;
        setRows(latest);
        const stillGoing = latest.filter((row) => row.state === "running");
        if (stillGoing.length === 0) {
          proceed();
          return;
        }
        if (Date.now() >= deadline) {
          for (const { id } of stillGoing) errors.set(id, "Still running after Stop.");
        }
      } catch (error) {
        if (!isCurrent()) return;
        setLoadError(extractError(error));
        break;
      }
      if (errors.size === 0) await new Promise((resolve) => window.setTimeout(resolve, STOP_CONFIRM_POLL_MS));
    }
    if (!isCurrent()) return;
    setStopErrors(errors);
    setMode("choose");
  }, [proceed, readRows, running]);

  const chats = rows?.filter((row) => row.kind === "chat") ?? [];
  const terminals = rows?.filter((row) => row.kind !== "chat") ?? [];
  const busy = mode !== "choose";

  // ADE cannot see whether a command is still running in a terminal, so it
  // never says "nothing is running" while one is open.
  const openTerminals = rows?.filter((row) => row.kind !== "chat" && row.state !== "running").length ?? 0;
  const terminalCaveat = openTerminals > 0
    ? ` ADE can't tell whether a command in ${openTerminals === 1 ? "the open terminal" : "an open terminal"} is still running.`
    : "";
  const where = machineName ? ` on ${machineName}` : "";
  const description = loadError
    ? `ADE could not read what is open in this lane${where}. You can still switch; open chats and terminals stay attached.`
    : rows == null
    ? "Checking what is running…"
    : running.length > 0
      ? `${plural(running.length, "session")} ${running.length === 1 ? "is" : "are"} still working${where}. Open chats and terminals stay attached and see the new branch.${terminalCaveat}`
      : `No chat is working${where}. Open chats and terminals stay attached and see the new branch.${terminalCaveat}`;

  const actions = mode === "waiting"
    ? [
        { label: `Waiting for ${plural(running.length, "session")}…`, busy: true, variant: "solid" as const, onClick: () => undefined },
        { label: "Stop waiting", variant: "secondary" as const, onClick: () => setMode("choose") },
      ]
    : mode === "stopping"
      ? [
          { label: "Stopping…", busy: true, disabled: true, variant: "solid" as const, onClick: () => undefined },
          { label: "Cancel", variant: "secondary" as const, disabled: true, onClick: onCancel },
        ]
      : running.length > 0
        ? [
            { label: "Wait, then switch", variant: "solid" as const, autoFocus: true, disabled: Boolean(loadError || stopErrors.size), title: "Switch as soon as the running work finishes", onClick: () => setMode("waiting") },
            { label: "Stop and switch", variant: "secondary" as const, disabled: Boolean(loadError), title: "Stops running chats and their supported background jobs, and closes running terminals and agent CLIs", onClick: () => { void stopAndContinue(); } },
            { label: "Cancel", variant: "secondary" as const, onClick: onCancel },
          ]
        : [
            { label: loadError || stopErrors.size > 0 ? "Switch anyway" : `Switch to ${targetLabel}`, variant: "solid" as const, autoFocus: true, disabled: rows == null && !loadError, onClick: proceed },
            { label: "Cancel", variant: "secondary" as const, onClick: onCancel },
          ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) onCancel(); }}
      title={running.length > 0 ? `Work is running in ${laneName}` : `Open work in ${laneName}`}
      description={description}
      tone="warning"
      icon
      size="md"
      role="alertdialog"
      dismissible={!busy}
      testId="lane-active-work-dialog"
      actions={actions}
      footerStart={running.length > 0 && mode === "choose" ? (
        <button
          type="button"
          className="text-[11px] underline-offset-2 hover:underline"
          style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
          title="Leave everything running and switch now"
          onClick={proceed}
        >
          Switch without stopping
        </button>
      ) : undefined}
    >
      {loadError ? (
        <div className="mb-2 flex items-center gap-2">
          <InlineErrorNotice id="lane-active-work-read" message={loadError} label="Could not read this lane's sessions" />
          <button type="button" className="text-[11px] underline-offset-2 hover:underline" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }} onClick={() => { void load(); }}>
            Read again
          </button>
        </div>
      ) : null}
      {stopErrors.size > 0 ? (
        <Banner
          layout="inline"
          style={{ marginBottom: 8 }}
          model={{
            id: "lane-active-work-stop",
            tone: "error",
            title: "ADE couldn’t verify that all work stopped",
            detail: "Check the affected sessions before switching.",
            report: {
              surface: "lane_active_work",
              code: "stop_unconfirmed",
              technicalDetail: [...new Set(stopErrors.values())].join("\n"),
            },
          }}
        />
      ) : null}
      <div className="flex flex-col gap-3">
        <ActiveWorkGroup label="Chats" icon={<ChatCircleDots size={12} />} rows={chats} stopErrors={stopErrors} />
        <ActiveWorkGroup label="Terminals" icon={<Terminal size={12} />} rows={terminals} stopErrors={stopErrors} />
      </div>
    </Dialog>
  );
}

function ActiveWorkGroup({
  label,
  icon,
  rows,
  stopErrors,
}: {
  label: string;
  icon: React.ReactNode;
  rows: LaneActiveWorkRow[];
  stopErrors: ReadonlyMap<string, string>;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={label}>
      <div className="mb-1 flex items-center gap-1.5" style={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted }}>
        {icon}
        <span>{label}</span>
        <span style={{ color: COLORS.textDim, fontWeight: 400 }}>{rows.length}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {rows.map(({ id, title, toolType, state }) => {
          const error = stopErrors.get(id);
          return (
            <li
              key={id}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1"
              style={{ background: state === "running" ? "color-mix(in srgb, var(--color-fg) 4%, transparent)" : undefined }}
              data-state={state}
            >
              <span className="flex w-4 shrink-0 justify-center"><ToolLogo toolType={toolType as TerminalToolType | null} size={13} /></span>
              <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, color: state === "open" ? COLORS.textSecondary : COLORS.textPrimary }}>
                {title}
              </span>
              {error ? (
                <span className="shrink-0 truncate" style={{ fontSize: 11, color: COLORS.danger, maxWidth: 200 }} title={error}>{error}</span>
              ) : (
                <span
                  className="shrink-0"
                  style={{
                    fontSize: 11,
                    color: state === "running" ? COLORS.success : state === "needs_you" ? COLORS.warning : COLORS.textDim,
                  }}
                >
                  {STATE_LABEL[state]}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
