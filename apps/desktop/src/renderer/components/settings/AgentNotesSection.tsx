import { useEffect, useState } from "react";
import type { ProjectNotesListResult } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { ModernRow, ModernRows, ModernSection } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";

/**
 * Project notes agents saved, read-only. Agents write them silently with
 * `ade notes` and every new agent session gets them in its prompt, so the user
 * must be able to see exactly what is there. Editing stays with the CLI.
 *
 * Read from the machine the page shows: project notes are the same everywhere,
 * and the "this computer" ones are that machine's.
 */
function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function AgentNotesSection() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const [result, setResult] = useState<ProjectNotesListResult | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setLoadFailed(false);
    window.ade.projectNotes
      .list({}, pin)
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the pin's key: a rebuilt pin for the same machine is no reason to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, attempt]);

  const notes = result?.notes ?? [];

  return (
    <ModernSection
      group="Agent notes"
      anchor="agent-notes"
      title="Agent notes"
      hint={<>What agents learned about working on this project. New agent sessions get them; change them with <code>ade notes</code>.</>}
      actions={result && notes.length > 0 ? (
        <span className="ade-modern-muted kit-num" title="How much of the notes budget each agent prompt uses">
          {formatKb(result.renderedBytes)} of {formatKb(result.limits.maxRenderedBytes)}
        </span>
      ) : undefined}
    >
      <ModernRows>
        {loadFailed ? (
          <ModernRow
            title="Couldn't load agent notes"
            control={(
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </button>
            )}
          />
        ) : !result ? (
          <ModernRow title={<span className="ade-modern-muted" aria-live="polite">Loading…</span>} />
        ) : notes.length === 0 ? (
          <ModernRow
            title="No notes yet"
            hint="Agents save one when they had to work out how to build, launch or test this project."
          />
        ) : (
          notes.map((note) => (
            <ModernRow
              key={note.id}
              title={note.body}
              hint={[
                note.section,
                note.scope === "machine" ? "This computer only" : "Every computer",
                `Updated ${relativeWhen(note.updatedAt)}`,
              ].join(" · ")}
            />
          ))
        )}
      </ModernRows>
    </ModernSection>
  );
}
