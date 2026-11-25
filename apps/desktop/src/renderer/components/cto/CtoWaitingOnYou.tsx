import React, { useState } from "react";
import { ArrowRight, HandPalm } from "@phosphor-icons/react";
import type { CtoNeed } from "../../../shared/types";

/** Rows shown before "+N more" opens the rest. */
const COLLAPSED_ROWS = 3;

/**
 * "Waiting on you": one line per chat the CTO started that needs the person,
 * at the foot of the CTO chat above the composer. The CTO sets each line
 * (`setNeed`); the host drops it once that chat moves. A row opens its chat.
 */
export function CtoWaitingOnYou({
  needs,
  onOpen,
}: {
  needs: readonly CtoNeed[];
  onOpen: (need: CtoNeed) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!needs.length) return null;
  const shown = expanded ? needs : needs.slice(0, COLLAPSED_ROWS);
  const hidden = needs.length - shown.length;
  return (
    <section className="ade-cto-needs" aria-label="Waiting on you" data-testid="cto-waiting-on-you">
      <header className="ade-cto-needs-head">
        <HandPalm size={13} weight="fill" aria-hidden />
        <span>Waiting on you</span>
        <span className="ade-cto-needs-count">{needs.length}</span>
      </header>
      <ul className="ade-cto-needs-list">
        {shown.map((need) => (
          <li key={need.childSessionId}>
            <button
              type="button"
              className="ade-cto-needs-row"
              title={`${need.line}\n${need.childTitle}`}
              onClick={() => onOpen(need)}
            >
              <span className="ade-cto-needs-line">{need.line}</span>
              <span className="ade-cto-needs-chat">{need.childTitle}</span>
              <ArrowRight size={12} className="ade-cto-needs-go" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button type="button" className="ade-cto-needs-more" onClick={() => setExpanded(true)}>
          +{hidden} more
        </button>
      ) : null}
    </section>
  );
}
