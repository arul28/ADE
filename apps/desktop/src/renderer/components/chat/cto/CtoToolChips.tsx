import React from "react";
import {
  Alarm,
  CalendarX,
  CheckCircle,
  Circle,
  PauseCircle,
  PlayCircle,
  Warning,
  type Icon,
} from "@phosphor-icons/react";
import type { ChatWorkLogEntry } from "../chatTranscriptRows";
import { ctoChipsForEntries, type CtoChipKind } from "./ctoToolWords";
import { CtoRemoteTaskRow } from "./CtoSpawnRows";
import "./ctoChat.css";

const CHIP_ICON: Record<CtoChipKind, Icon> = {
  scheduled: Alarm,
  cancelled: CalendarX,
  paused: PauseCircle,
  resumed: PlayCircle,
  tracking: Circle,
  done: CheckCircle,
  started: PlayCircle,
};

/**
 * The CTO's state changes, as quiet chips in its thread: "Scheduled · Daily
 * check-in", "Tracking · Ship the release notes". One line each,
 * the full text in the tooltip; a row of them wraps only between whole chips.
 * They stand in for the tool rows the CTO thread does not draw; a call that is
 * still running draws nothing here (the working line names it).
 */
export function CtoToolChips({ entries }: { entries: readonly ChatWorkLogEntry[] }) {
  const all = ctoChipsForEntries(entries);
  if (all.length === 0) return null;
  // A chat started on another machine draws the same row a local spawn does;
  // a spawn that failed stays a chip ("Couldn't start").
  const started = all.flatMap((chip) => (chip.remote ? [{ id: chip.id, title: chip.text, remote: chip.remote }] : []));
  const chips = all.filter((chip) => !chip.remote);
  return (
    <>
      {started.length ? (
        <div className="ade-cto-spawns">
          {started.map((spawn) => <CtoRemoteTaskRow key={spawn.id} title={spawn.title} remote={spawn.remote} />)}
        </div>
      ) : null}
      {chips.length ? <CtoChipRow chips={chips} /> : null}
    </>
  );
}

function CtoChipRow({ chips }: { chips: ReturnType<typeof ctoChipsForEntries> }) {
  return (
    <div className="ade-cto-chips" data-testid="cto-tool-chips">
      {chips.map((chip) => {
        const Glyph = chip.failed ? Warning : CHIP_ICON[chip.kind];
        const label = chip.text ? `${chip.verb} · ${chip.text}` : chip.verb;
        return (
          <span
            key={chip.id}
            className="ade-cto-chip"
            data-failed={chip.failed ? "true" : undefined}
            data-kind={chip.kind}
            title={label}
          >
            <Glyph size={11} weight={chip.kind === "done" && !chip.failed ? "fill" : "regular"} className="ade-cto-chip-icon" aria-hidden />
            <span className="ade-cto-chip-verb">{chip.verb}</span>
            {chip.text ? (
              <>
                <span className="ade-cto-chip-sep" aria-hidden>·</span>
                <span className="ade-cto-chip-text">{chip.text}</span>
              </>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * ADE gave the CTO a fresh provider thread: notes, open work and the recent
 * conversation carried over. A hairline, not a card: nothing to act on.
 */
export function CtoFreshContextDivider({ message }: { message: string | null | undefined }) {
  return (
    <div className="ade-cto-fresh" role="separator" aria-label="Fresh context" title={message?.trim() || undefined} data-testid="cto-fresh-context">
      <span className="ade-cto-fresh-rule" />
      <span className="ade-cto-fresh-label">Fresh context</span>
      <span className="ade-cto-fresh-rule" />
    </div>
  );
}
