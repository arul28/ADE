import { useCallback, useEffect, useState } from "react";
import type { DatabaseCopyInfo } from "../../../shared/types/startupRecovery";
import { revealLabel } from "../../lib/platform";
import { formatBytesShort } from "../home/widgets/widgetHooks";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { ModernRow, ModernRows, ModernSection } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";

function databaseName(copy: DatabaseCopyInfo): string {
  if (copy.databaseKind === "machine") return "This computer";
  if (copy.databaseKind === "personal") return "Personal chats";
  return copy.databaseLabel;
}

function takenAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function moveText(copy: DatabaseCopyInfo): string {
  return copy.fromVersion
    ? `From ${copy.fromVersion} to ${copy.toVersion}`
    : `Before ${copy.toVersion}`;
}

/**
 * Settings › Advanced › Database copies: the copies ADE takes before a new
 * version first opens a database (docs/plans/beta-track.md).
 *
 * This computer only. The list, reveal and delete are plain IPC to this
 * desktop's main process (no pin), so the section renders nothing when
 * Settings is scoped to another machine; that machine lists its own.
 *
 * No restore button: putting a copy back while ADE runs would swap a file
 * under the brain that has it open. "Go back" in the "ADE could not start"
 * window restores, after the brain has stopped.
 */
export function DatabaseCopiesSection() {
  const { isThisMachine } = useSettingsMachineScope();
  const [copies, setCopies] = useState<DatabaseCopyInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.ade?.databaseCopies;
    if (!api) {
      setCopies([]);
      return;
    }
    try {
      setCopies(await api.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCopies([]);
    }
  }, []);

  useEffect(() => {
    if (isThisMachine) void refresh();
  }, [isThisMachine, refresh]);

  const reveal = useCallback(async (copy: DatabaseCopyInfo) => {
    setError(null);
    const result = await window.ade?.databaseCopies?.reveal(copy.path).catch(() => ({ revealed: false }));
    if (!result?.revealed) {
      setError("That copy is no longer on this computer.");
      void refresh();
    }
  }, [refresh]);

  const remove = useCallback(async (copy: DatabaseCopyInfo) => {
    const confirmed = await confirmDialog({
      title: "Delete this copy?",
      message: `${databaseName(copy)}, ${moveText(copy).toLowerCase()}, taken ${takenAt(copy.takenAt)}. ADE can't go back to this data without it.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setError(null);
    setBusyPath(copy.path);
    try {
      const result = await window.ade?.databaseCopies?.delete(copy.path);
      if (result && !result.deleted) setError(result.reason);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPath(null);
      void refresh();
    }
  }, [refresh]);

  if (!isThisMachine) return null;

  return (
    <ModernSection
      group="Database copies"
      anchor="database-copies"
      title="Database copies"
      hint="ADE copies each database before a new version first opens it. Going back to an older version puts the copy back."
    >
      {error ? <Banner layout="inline" model={{ id: "database-copies-error", tone: "error", title: error }} /> : null}
      <ModernRows>
        {copies === null ? (
          <ModernRow title="Loading…" />
        ) : copies.length === 0 ? (
          <ModernRow title="No copies yet" hint="ADE makes one the next time an update opens your data." />
        ) : (
          copies.map((copy) => (
            <ModernRow
              key={copy.path}
              title={databaseName(copy)}
              hint={
                <span>
                  {moveText(copy)} · {takenAt(copy.takenAt)} · <span className="kit-num">{formatBytesShort(copy.sizeBytes)}</span>
                </span>
              }
              control={
                <>
                  <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => void reveal(copy)}>
                    {revealLabel}
                  </button>
                  <button
                    type="button"
                    className="ade-modern-btn"
                    data-size="sm"
                    data-tone="danger"
                    disabled={busyPath === copy.path}
                    onClick={() => void remove(copy)}
                  >
                    Delete
                  </button>
                </>
              }
            />
          ))
        )}
      </ModernRows>
    </ModernSection>
  );
}
