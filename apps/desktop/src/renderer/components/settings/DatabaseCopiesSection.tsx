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
  if (copy.kept) {
    return copy.fromVersion
      ? `Set aside when ADE went back from ${copy.fromVersion} to ${copy.toVersion}`
      : `Set aside when ADE went back to ${copy.toVersion}`;
  }
  return copy.fromVersion
    ? `Before the update from ${copy.fromVersion} to ${copy.toVersion}`
    : `Before the update to ${copy.toVersion}`;
}

/**
 * Settings › Advanced › Database copies: the copy ADE takes before a new
 * version first opens a database, and what "Go back" set aside
 * (docs/plans/beta-track.md). ADE deletes them itself
 * (`clearProvenDatabaseCopies`); Delete here is for the person who wants the
 * space now.
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
      message: copy.kept
        ? `${databaseName(copy)}: what the newer version left when ADE went back, saved ${takenAt(copy.takenAt)}. ADE support may ask for it.`
        : `${databaseName(copy)}: your data from before the update to ${copy.toVersion}, saved ${takenAt(copy.takenAt)}. Without it, ADE can't go back to that version if the update breaks.`,
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
      hint="ADE keeps one copy of each database from the last update, and deletes it once the update has worked for a day."
    >
      {error ? <Banner layout="inline" model={{ id: "database-copies-error", tone: "error", title: error }} /> : null}
      <ModernRows>
        {copies === null ? (
          <ModernRow title="Loading…" />
        ) : copies.length === 0 ? (
          <ModernRow title="No copies right now" hint="ADE makes one the next time an update changes your data." />
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
