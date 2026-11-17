import { useMemo } from "react";
import type { CloudCtoCopy } from "../../../../../account-directory/src/cloud/contract";
import { savedAgoLabel, useAdeCloudAccountRead } from "../../lib/adeCloudAccountRead";
import { AccountReadFailed } from "../adeCloud/AccountReadFailed";

/**
 * The CTO's account copy (`GET /cloud/cto`), read-only, for a CTO whose home
 * computer is asleep, gone or away: its last turns, its open work, its notes
 * and its routines, as its home last saved them. Reading never wakes the home.
 *
 * Renders nothing on an ADE or a server without the copy route, and nothing
 * when the repository has no copy yet (the state card above says what to do).
 */
export function CtoAccountCopyView({ origin, active }: { origin: string | null; active: boolean }): JSX.Element | null {
  const { state, retry } = useAdeCloudAccountRead(active && origin ? { call: "cto" as const, origin } : null);
  if (state.status === "failed" && !state.data) {
    return (
      <div className="ade-cto-copy">
        <AccountReadFailed id="cto-copy" what="the CTO's saved notes" code={state.code} message={state.message} onRetry={retry} />
      </div>
    );
  }
  const copy = state.data?.available ? state.data.copy : null;
  if (!copy) return null;
  return <CtoCopyBody copy={copy} />;
}

/** The name the copy saved for the CTO, for the page header while no home answers. */
export function ctoCopyName(copy: CloudCtoCopy | null | undefined): string | null {
  const name = copy?.identity?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function CtoCopyBody({ copy }: { copy: CloudCtoCopy }): JSX.Element {
  const saved = savedAgoLabel(copy.savedAt);
  const notes = useMemo(
    () => [copy.projectNotes, copy.userNotes].map((note) => note.trim()).filter(Boolean),
    [copy.projectNotes, copy.userNotes],
  );
  const tail = copy.tail.trim();
  return (
    <section className="ade-cto-copy" aria-label="The CTO's saved copy" data-testid="cto-account-copy">
      <p className="ade-cto-copy-note">
        {saved ? `${saved} from ${copy.ownerName || "its home computer"}.` : "Saved from its home computer."}
        {" "}Reading this doesn't wake it.
      </p>
      {copy.story?.summary ? (
        <CopyPart title="Where things stand">
          <p className="ade-cto-copy-text">{copy.story.summary}</p>
        </CopyPart>
      ) : null}
      {copy.openWork?.trim() ? (
        <CopyPart title="Open work">
          <p className="ade-cto-copy-text">{copy.openWork.trim()}</p>
        </CopyPart>
      ) : null}
      {tail ? (
        <CopyPart title="Last turns">
          <pre className="ade-cto-copy-tail" tabIndex={0}>
            {copy.tailTruncated ? "…\n" : ""}
            {tail}
          </pre>
        </CopyPart>
      ) : null}
      {notes.length ? (
        <CopyPart title="Notes">
          {notes.map((note, index) => <p key={index} className="ade-cto-copy-text">{note}</p>)}
        </CopyPart>
      ) : null}
      {copy.routines.length ? (
        <CopyPart title="Routines">
          <ul className="ade-cto-copy-routines">
            {copy.routines.map((routine, index) => (
              <li key={`${routine.title}-${index}`}>
                <span className="ade-cto-copy-routine-title">{routine.title}</span>
                <span className="ade-cto-copy-routine-when">
                  {routine.paused ? "Paused" : routine.cron}
                  {!routine.paused && routine.timeZone ? ` (${routine.timeZone})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </CopyPart>
      ) : null}
    </section>
  );
}

function CopyPart({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="ade-cto-copy-part">
      <h3 className="ade-cto-copy-heading">{title}</h3>
      {children}
    </div>
  );
}
