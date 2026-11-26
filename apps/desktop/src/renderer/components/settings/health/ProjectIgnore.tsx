import React from "react";
import { CaretRight, EyeSlash, FolderSimpleDashed } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { ProjectHealthIgnore, ProjectHealthIssue, ProjectHealthReport } from "../../../../shared/types/projectHealth";
import { isProjectHealthReadFailure, projectHealthIgnoreKey } from "../../../../shared/types/projectHealth";
import { projectIssuePage, type ProjectIssuePage } from "./healthModel";
import { pluralCount } from "../../../../shared/formatting";
import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { showToast } from "../../app/toast/toastStore";
import "./projectIgnore.css";

/**
 * "Ignore" for the things Settings flags.
 *
 * Two ways to stop seeing something, and the menu says which is which:
 *
 * - **Ignore a folder.** The dependencies check names folders; a demo or
 *   sample package is never installed on purpose. Ignoring it stops the check
 *   looking there at all, until the person shows it again.
 * - **Hide until it changes.** Any line. It comes back as soon as it reads
 *   differently (another folder, another lane), so nothing new is ever hidden.
 *
 * A project's ignores live in the project (the brain behind `pin`), so every
 * computer and client sees the same list. The rows outside the project hide
 * on this computer only (`useNeedsAttention`). Both end up in `IgnoredList`.
 */

/** One way to stop seeing a row, as the Ignore menu lists it. */
export type IgnoreChoice = {
  id: string;
  label: string;
  hint: string;
  kind: "folder" | "hide";
  run: () => void;
};

/** One entry of the ignored list, wherever it is stored. */
export type IgnoredEntry = {
  key: string;
  title: string;
  /** "Not checked for packages", "Hidden until it changes". */
  note: string;
  kind: "folder" | "hide";
  /** Where it applies, when the list mixes places: "Project", "This computer". */
  where?: string;
  showAgain: () => void;
};

const IGNORE_TOAST_ID = "settings-project-ignore";

/**
 * One coarse fact per decision (`ade_feature_used`, feature "attention"): which
 * kind of ignore, never the folder, the line or the project. Deduped per
 * action for an hour, so at most 72 a day per installation.
 */
export function captureAttentionIgnore(action: "attention_folder_ignored" | "attention_hidden" | "attention_shown_again"): void {
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: { feature: "attention", action, outcome: "completed", source: "renderer_route" },
    dedupeKey: `attention_ignore:${action}`,
    minimumIntervalMs: 60 * 60_000,
  }).catch(() => undefined);
}

/** "Hide until it changes", the one choice every hideable row offers, wherever it is stored. */
export function hideUntilChangedChoice(run: () => void): IgnoreChoice {
  return { id: "hide", label: "Hide until it changes", hint: "It comes back if anything about it changes", kind: "hide", run };
}

/** Ignore for a list of checks: the menu for each line and the list of what was ignored. */
export type ProjectIssueIgnore = {
  choicesFor: (issue: ProjectHealthIssue) => IgnoreChoice[];
  entries: readonly IgnoredEntry[];
  busy: boolean;
};

/** The ignore and show-again calls for one project copy, each with its toast. */
export function useProjectIgnore(pin: OpenProjectBinding | null, onReport: (report: ProjectHealthReport) => void) {
  const [busy, setBusy] = React.useState(false);
  // A reply from a copy the page has since left must not paint over the copy it shows now.
  const pinKeyRef = React.useRef(pin?.key ?? null);
  pinKeyRef.current = pin?.key ?? null;
  const report = React.useCallback((sentTo: string | null, next: ProjectHealthReport) => {
    if (sentTo === pinKeyRef.current) onReport(next);
  }, [onReport]);
  const unignore = React.useCallback(async (key: string, quiet = false) => {
    if (!pin) return;
    setBusy(true);
    try {
      report(pin.key, await window.ade.projectHealth.unignore({ key }, pin));
      captureAttentionIgnore("attention_shown_again");
      if (!quiet) showToast({ id: IGNORE_TOAST_ID, tone: "success", title: "Showing it again" });
    } catch (err) {
      showToast({ id: IGNORE_TOAST_ID, tone: "error", title: "Couldn't show it again", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [pin, report]);

  const ignore = React.useCallback(async (issue: ProjectHealthIssue, folder: string | null) => {
    if (!pin) return;
    setBusy(true);
    try {
      const next = await window.ade.projectHealth.ignore({
        issueId: issue.id,
        // A folder is ignored by name; a hidden line must still read as it did on screen.
        ...(folder ? { path: folder } : { seen: { title: issue.title, items: issue.items ?? [], ignorablePaths: issue.ignorablePaths ?? [] } }),
      }, pin);
      report(pin.key, next);
      captureAttentionIgnore(folder ? "attention_folder_ignored" : "attention_hidden");
      // The brain names the key (a line hide carries its copy); read it back for Undo.
      const key = folder
        ? projectHealthIgnoreKey(issue.id, folder)
        : next.ignored?.find((entry) => entry.kind === "issue" && entry.issueId === issue.id)?.key ?? projectHealthIgnoreKey(issue.id);
      showToast({
        id: IGNORE_TOAST_ID,
        tone: "success",
        title: folder ? `Ignoring ${folder}` : "Hidden until it changes",
        message: folder ? "ADE won't check this folder for packages again." : undefined,
        actions: [{ label: "Undo", onClick: () => void unignore(key, true) }],
      });
    } catch (err) {
      showToast({ id: IGNORE_TOAST_ID, tone: "error", title: "Couldn't ignore it", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [pin, report, unignore]);

  /**
   * The menu for one project line: a choice per folder it names, then "hide
   * until it changes". A problem, or a check that couldn't run, has no
   * "hide": it stays in view until it is fixed or runs.
   */
  const choicesFor = React.useCallback((issue: ProjectHealthIssue): IgnoreChoice[] => [
    ...(issue.ignorablePaths ?? []).map((folder): IgnoreChoice => ({
      id: `folder:${folder}`,
      label: `Ignore ${folder}`,
      hint: "Stop checking this folder for packages",
      kind: "folder",
      run: () => void ignore(issue, folder),
    })),
    ...(issue.severity === "problem" || isProjectHealthReadFailure(issue.id) ? [] : [hideUntilChangedChoice(() => void ignore(issue, null))]),
  ], [ignore]);

  /** The project's ignores as list entries; `page` keeps only the ones a page's checks own. */
  const entriesFor = React.useCallback((report: ProjectHealthReport | null, page?: ProjectIssuePage): IgnoredEntry[] => (report?.ignored ?? [])
    .filter((entry) => !page || projectIssuePage({ id: entry.issueId }) === page)
    .map((entry: ProjectHealthIgnore) => ({
      key: entry.key,
      title: entry.title,
      note: entry.kind === "folder" ? "Not checked for packages" : "Hidden until it changes",
      kind: entry.kind === "folder" ? "folder" : "hide",
      where: "Project",
      showAgain: () => void unignore(entry.key),
    })), [unignore]);

  /** Everything one page of checks passes to its list. */
  const forPage = React.useCallback((report: ProjectHealthReport | null, page: ProjectIssuePage): ProjectIssueIgnore => ({
    choicesFor,
    entries: entriesFor(report, page),
    busy,
  }), [busy, choicesFor, entriesFor]);

  return { busy, ignore, unignore, choicesFor, entriesFor, forPage };
}

/**
 * The quiet eye-slash beside a row's own buttons. One choice runs at once
 * (its toast carries Undo); several open a small menu that says what each does.
 */
export function IgnoreButton({ choices, subject, disabled }: { choices: readonly IgnoreChoice[]; subject: string; disabled?: boolean }) {
  const anchorRef = React.useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const firstItemRef = React.useRef<HTMLButtonElement | null>(null);
  // The menu is hidden for the frame before it is placed, and a hidden item
  // cannot take focus: move focus in once it is on screen.
  React.useEffect(() => {
    if (!open) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => firstItemRef.current?.focus());
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [open]);
  if (choices.length === 0) return null;
  const single = choices.length === 1 ? choices[0]! : null;
  const close = () => {
    setOpen(false);
    anchorRef.current?.focus();
  };
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="kit-icon-btn ade-ignore-btn"
        aria-label={single ? `${single.label}: ${subject}` : `Ignore: ${subject}`}
        aria-haspopup={single ? undefined : "menu"}
        aria-expanded={single ? undefined : open}
        title={single ? single.label : "Ignore"}
        disabled={disabled}
        data-open={open || undefined}
        onClick={() => (single ? single.run() : setOpen((value) => !value))}
        onKeyDown={(event) => {
          // Arrow keys on the trigger open the menu (or step into it) instead of scrolling the page.
          if (single || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          if (open) firstItemRef.current?.focus();
          else setOpen(true);
        }}
      >
        <EyeSlash size={14} />
      </button>
      {single ? null : (
        <AnchoredMenu
          open={open}
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          placement="bottom-end"
          offset={6}
          role="menu"
          aria-label={`Ignore: ${subject}`}
          className="ade-ignore-menu"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {choices.map((choice, index) => (
            <React.Fragment key={choice.id}>
              {choice.kind === "hide" && index > 0 ? <div className="ade-ignore-menu-rule" role="separator" /> : null}
              <button
                ref={index === 0 ? firstItemRef : undefined}
                type="button"
                role="menuitem"
                className="ade-ignore-menu-item"
                onClick={() => {
                  close();
                  choice.run();
                }}
              >
                <span className="ade-ignore-menu-glyph" aria-hidden>
                  {choice.kind === "folder" ? <FolderSimpleDashed size={15} /> : <EyeSlash size={15} />}
                </span>
                <span className="ade-ignore-menu-text">
                  <span className="ade-ignore-menu-label">{choice.label}</span>
                  <span className="ade-ignore-menu-hint">{choice.hint}</span>
                </span>
              </button>
            </React.Fragment>
          ))}
        </AnchoredMenu>
      )}
    </>
  );
}

/**
 * What the person ignored, folded under one quiet line ("2 ignored"), each
 * with Show again. It sits under the rows it came from, so the way back is
 * where the thing used to be.
 */
export function IgnoredList({ entries, busy, defaultOpen = false }: { entries: readonly IgnoredEntry[]; busy?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const listId = React.useId();
  // Hiding the last row on show leaves only this list: open it, so the way back is in view.
  React.useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  if (entries.length === 0) return null;
  return (
    <div className="ade-ignored" data-open={open || undefined}>
      <button
        type="button"
        className="ade-ignored-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <EyeSlash size={13} aria-hidden />
        <span>{pluralCount(entries.length, "ignored item", "ignored items")}</span>
        <CaretRight size={10} weight="bold" className="ade-ignored-caret" aria-hidden />
      </button>
      {open ? (
        <ul className="ade-ignored-list" id={listId}>
          {entries.map((entry) => (
            <li key={entry.key} className="ade-ignored-row">
              <span className="ade-ignored-glyph" aria-hidden>
                {entry.kind === "folder" ? <FolderSimpleDashed size={14} /> : <EyeSlash size={14} />}
              </span>
              <span className="ade-ignored-text">
                <span className="ade-ignored-title">{entry.title}</span>
                <span className="ade-ignored-note">
                  {entry.where ? <span className="ade-ignored-where">{entry.where}</span> : null}
                  {entry.note}
                </span>
              </span>
              <button
                type="button"
                className="ade-modern-btn"
                data-size="sm"
                data-variant="ghost"
                disabled={busy}
                aria-label={`Show again: ${entry.title}`}
                onClick={entry.showAgain}
              >
                Show again
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
