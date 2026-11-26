import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatCircleDots, Terminal } from "@phosphor-icons/react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../../shared/types";
import { isChatToolType } from "../../../../shared/sessionSpawnNesting";
import { THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import { canonicalInputFromSummary, sessionCanonicalUiState, sessionIsMidFlight } from "../../../lib/terminalAttention";
import { primarySessionLabel } from "../../../lib/sessions";
import { extractError } from "../../../lib/format";
import { useMachineEntryForBinding, usePinTargetsTab } from "../../../state/crossMachineLanes";
import { Dialog } from "../../ui/dialog/Dialog";
import { ToolLogo } from "../../terminals/ToolLogos";
import { COLORS, SANS_FONT } from "../laneDesignTokens";

/** What one open session in the lane is doing, for the dialog. */
export type LaneActiveWorkRow = {
  session: TerminalSessionSummary;
  kind: "chat" | "cli" | "terminal";
  /** `running`: will change on its own. `needs_you`: waiting on the person. `open`: at rest. */
  state: "running" | "needs_you" | "open";
};

/** Open sessions in a lane, classified the way the Work tab reads them. */
export function classifyLaneActiveWork(sessions: readonly TerminalSessionSummary[]): LaneActiveWorkRow[] {
  const rank = { running: 0, needs_you: 1, open: 2 } as const;
  return sessions
    .filter((session) => !session.archivedAt && !session.endedAt)
    .map((session): LaneActiveWorkRow => {
      const input = canonicalInputFromSummary(session);
      const state = sessionIsMidFlight(input)
        ? "running"
        : sessionCanonicalUiState(input).phase === "needs_you" ? "needs_you" : "open";
      const kind = isChatToolType(session.toolType)
        ? "chat"
        : !session.toolType || session.toolType === "shell" ? "terminal" : "cli";
      return { session, kind, state };
    })
    .sort((a, b) => rank[a.state] - rank[b.state]);
}

/** How often "Wait, then switch" re-reads the lane when no change event arrives. */
const WAIT_BACKSTOP_MS = 4_000;

const STATE_LABEL: Record<LaneActiveWorkRow["state"], string> = {
  running: "Running",
  needs_you: "Waiting for you",
  open: "Open",
};

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
  // Read through refs so a rebuilt pin or callback with the same meaning
  // restarts nothing.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;
  const continuedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const sessions = await window.ade.sessions.list({ laneId, limit: 200, includeArchived: false }, pinRef.current);
      setRows(classifyLaneActiveWork(sessions.filter((session) => session.laneId === laneId)));
      setLoadError(null);
    } catch (error) {
      setLoadError(extractError(error));
    }
  }, [laneId]);

  // Read the lane while open, and again whenever a session on its machine
  // changes, so "Waiting" sees work finish without polling.
  const pinKey = pin.key;
  useEffect(() => {
    if (!open) return undefined;
    continuedRef.current = false;
    setRows(null);
    setMode("choose");
    setStopErrors(new Map());
    void load();
    let timer: number | null = null;
    const unsubscribe = window.ade.sessions.onChanged(() => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void load(); }, 300);
    }, pinRef.current);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [laneId, load, open, pinKey]);

  const running = useMemo(() => rows?.filter((row) => row.state === "running") ?? [], [rows]);

  const proceed = useCallback(() => {
    if (continuedRef.current) return;
    continuedRef.current = true;
    onContinueRef.current();
  }, []);

  // Waiting ends by itself once nothing in the lane is running.
  useEffect(() => {
    if (mode === "waiting" && rows && running.length === 0) proceed();
  }, [mode, proceed, rows, running.length]);

  // A turn can end without a session change event; while the person waits,
  // read the lane again now and then as a backstop. Only while waiting.
  useEffect(() => {
    if (!open || mode !== "waiting") return undefined;
    const interval = window.setInterval(() => { void load(); }, WAIT_BACKSTOP_MS);
    return () => window.clearInterval(interval);
  }, [load, mode, open]);

  const stopAndContinue = useCallback(async () => {
    setMode("stopping");
    const errors = new Map<string, string>();
    await Promise.all(running.map(async ({ session, kind }) => {
      try {
        if (kind === "chat") {
          await window.ade.agentChat.interrupt({ sessionId: session.id }, pinRef.current);
        } else if (session.ptyId) {
          const result = await window.ade.pty.dispose({ ptyId: session.ptyId, sessionId: session.id }, pinRef.current);
          if (result?.disposed === false && (result.reason === "owned-by-peer" || result.reason === "session-mismatch")) {
            errors.set(session.id, "Another window owns this terminal.");
          }
        }
      } catch (error) {
        errors.set(session.id, extractError(error));
      }
    }));
    if (errors.size > 0) {
      setStopErrors(errors);
      setMode("choose");
      void load();
      return;
    }
    proceed();
  }, [load, proceed, running]);

  const chats = rows?.filter((row) => row.kind === "chat") ?? [];
  const terminals = rows?.filter((row) => row.kind !== "chat") ?? [];
  const busy = mode !== "choose";

  const description = rows == null
    ? "Checking what is running…"
    : running.length > 0
      ? `${plural(running.length, "session")} ${running.length === 1 ? "is" : "are"} still working${machineName ? ` on ${machineName}` : ""}. Open chats and terminals stay attached and see the new branch.`
      : `Nothing is running${machineName ? ` on ${machineName}` : ""}. Open chats and terminals stay attached and see the new branch.`;

  const actions = mode === "waiting"
    ? [
        { label: `Waiting for ${plural(running.length, "session")}…`, busy: true, variant: "solid" as const, onClick: () => undefined },
        { label: "Stop waiting", variant: "secondary" as const, onClick: () => setMode("choose") },
      ]
    : running.length > 0
      ? [
          { label: "Wait, then switch", variant: "solid" as const, autoFocus: true, disabled: busy, title: "Switch as soon as the running work finishes", onClick: () => setMode("waiting") },
          { label: mode === "stopping" ? "Stopping…" : "Stop and switch", busy: mode === "stopping", disabled: busy, variant: "secondary" as const, title: "Stop the running chats and terminals, then switch", onClick: () => { void stopAndContinue(); } },
          { label: "Cancel", variant: "secondary" as const, disabled: busy, onClick: onCancel },
        ]
      : [
          { label: `Switch to ${targetLabel}`, variant: "solid" as const, autoFocus: true, disabled: rows == null, onClick: proceed },
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
        <div style={{ fontSize: 12, color: COLORS.danger }}>Could not read this lane's sessions: {loadError}</div>
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
        {rows.map(({ session, state }) => {
          const error = stopErrors.get(session.id);
          return (
            <li
              key={session.id}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1"
              style={{ background: state === "running" ? "color-mix(in srgb, var(--color-fg) 4%, transparent)" : undefined }}
              data-state={state}
            >
              <span className="flex w-4 shrink-0 justify-center"><ToolLogo toolType={session.toolType} size={13} /></span>
              <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, color: state === "open" ? COLORS.textSecondary : COLORS.textPrimary }}>
                {primarySessionLabel(session)}
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
