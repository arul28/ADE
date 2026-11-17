import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Play, Terminal as TerminalIcon } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { stripAnsi } from "../../../shared/ansiStrip";
import { SAVED_CHATS_MACHINE_PREFIX } from "../../../shared/cloudSavedChats";
import { savedAgoLabel, useAdeCloudAccountRead } from "../../lib/adeCloudAccountRead";
import { useCloudMachineWakeFailure, useCloudMachineWakeInFlight, wakeRestingCloudMachine } from "../../lib/cloudMachineWake";
import { savedTerminalAddress } from "../../state/cloudSavedTerminals";
import { AccountReadFailed } from "../adeCloud/AccountReadFailed";
import { Button } from "../ui/Button";
import { normalizeTranscriptToGrid } from "./terminalTranscriptNormalize";

/**
 * CLI and shell copies of an ADE Cloud computer that is not on: the text the
 * computer saved when it went to rest (`GET /cloud/sessions/:m/:s`). A shell
 * shows its last 5,000 lines; a CLI shows its saved screen. Read-only: the
 * terminal itself lives on the computer, and "Continue" wakes it.
 */

/** A shell shows at most this many lines of its saved text. */
const SHELL_LINES = 5_000;

function lastLines(text: string, count: number): { text: string; cut: boolean } {
  let index = text.length;
  for (let seen = 0; seen < count; seen += 1) {
    index = text.lastIndexOf("\n", index - 1);
    if (index < 0) return { text, cut: false };
  }
  return { text: text.slice(index + 1), cut: true };
}

/** The saved text as the person reads it: plain lines, colors and cursor moves resolved. */
function useReadableCopy(format: "text" | "xterm" | null, raw: string | null): { text: string | null; cut: boolean } {
  const [screen, setScreen] = useState<string | null>(null);
  useEffect(() => {
    setScreen(null);
    if (format !== "xterm" || !raw) return undefined;
    let cancelled = false;
    void normalizeTranscriptToGrid(raw).then((grid) => {
      if (!cancelled) setScreen(grid ?? stripAnsi(raw));
    });
    return () => {
      cancelled = true;
    };
  }, [format, raw]);
  return useMemo(() => {
    if (raw == null || format == null) return { text: null, cut: false };
    if (format === "xterm") return { text: screen, cut: false };
    return lastLines(stripAnsi(raw), SHELL_LINES);
  }, [format, raw, screen]);
}

/**
 * The read-only view of one saved terminal copy. Reading it never wakes the
 * computer; "Continue" does, and the live terminal opens when it connects.
 */
export function SavedTerminalCopyView({
  session,
  onContinued,
}: {
  session: Pick<TerminalSessionSummary, "id" | "title" | "toolType" | "lastActivityAt">;
  /** Runs once the woken computer is connected (the caller opens the live terminal). */
  onContinued?: () => void;
}): JSX.Element | null {
  const address = savedTerminalAddress(session.id);
  const { state, retry } = useAdeCloudAccountRead(address ? { call: "savedSession" as const, ...address } : null);
  const copy = state.data ?? null;
  const readable = useReadableCopy(copy?.format ?? null, copy?.text ?? null);
  const machineKey = address?.machineKey ?? null;
  const waking = useCloudMachineWakeInFlight(machineKey);
  const wakeFailure = useCloudMachineWakeFailure(machineKey);
  if (!address) return null;

  const isShell = session.toolType === "shell";
  const saved = savedAgoLabel(copy?.session.updatedAt ?? session.lastActivityAt);
  const continueWork = () => {
    wakeRestingCloudMachine(
      { machineId: `${SAVED_CHATS_MACHINE_PREFIX}${address.machineKey}`, machineName: "ADE Cloud", hostname: copy?.session.instanceId ?? null },
      () => onContinued?.(),
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden" data-testid="saved-terminal-copy">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/40 px-4 py-2.5">
        <TerminalIcon size={15} className="shrink-0 text-muted-fg/70" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-fg">{session.title ?? (isShell ? "Shell" : "CLI")}</div>
          <div className="truncate text-[11px] text-muted-fg/70">
            {saved ?? "Saved"} on ADE Cloud. {isShell ? "The last lines it showed." : "Its screen when it went to rest."} Reading this doesn't wake it.
          </div>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={waking}
          onClick={continueWork}
          title="Wake the computer and open the live terminal"
        >
          <Play size={12} weight="fill" />
          {waking ? "Waking…" : "Continue"}
        </Button>
      </div>
      {wakeFailure ? (
        <div className="shrink-0 px-4 pt-3 text-[11.5px] text-red-300" role="alert">{wakeFailure}</div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto bg-black/20">
        {state.status === "failed" && !copy ? (
          <div className="p-4">
            <AccountReadFailed id="saved-terminal" what="the saved terminal" code={state.code} message={state.message} onRetry={retry} />
          </div>
        ) : state.status === "unsupported" ? (
          <div className="p-4 text-[12px] text-muted-fg/75">This ADE can't read saved terminals. Continue to open it on its computer.</div>
        ) : state.status === "ready" && !copy ? (
          <div className="flex flex-col items-start gap-2 p-4 text-[12px] text-muted-fg/75">
            <span>This terminal has no saved copy any more.</span>
            <Button size="sm" variant="ghost" onClick={retry}>
              <ArrowClockwise size={12} />
              Retry
            </Button>
          </div>
        ) : readable.text == null ? (
          <div className="flex flex-col gap-1.5 p-4" aria-busy="true" aria-label="Loading the saved terminal">
            {[0, 1, 2, 3].map((index) => <div key={index} className="h-3 w-2/3 animate-pulse rounded bg-fg/[0.05]" />)}
          </div>
        ) : (
          <pre
            className="m-0 min-h-full whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-[1.45] text-fg/85 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent/60"
            tabIndex={0}
            aria-label={`Saved text of ${session.title ?? "the terminal"}`}
          >
            {readable.cut ? `… (the last ${SHELL_LINES.toLocaleString()} lines)\n` : ""}
            {readable.text || (isShell ? "(The shell showed nothing.)" : "(The screen was empty.)")}
          </pre>
        )}
      </div>
    </div>
  );
}
