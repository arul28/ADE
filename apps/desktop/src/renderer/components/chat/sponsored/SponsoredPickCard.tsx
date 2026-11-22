import { useContext, useState } from "react";
import { ArrowUpRight } from "@phosphor-icons/react";
import type { AdeCardPayload } from "../../../../shared/adeCard";
import { sponsoredPickOfCard, sponsoredPickUseText } from "../../../../shared/sponsoredPick";
import { openExternalUrl } from "../../../lib/openExternal";
import { SceneReplyContext } from "../SceneFrame";
import "./sponsored.css";

/**
 * An agent's Sponsored recommendation (`cloud.recommend`, Gravity's Index):
 * calm, labeled, and inert. Open site follows Gravity's tracked link; Use it
 * puts the steps in the prompt box, so nothing is set up until the person
 * sends it. Not now folds it to one line. A subagent view has no prompt box
 * (no `SceneReplyContext`), so it shows no Use it.
 */
export function SponsoredPickCard({ card }: { card: AdeCardPayload }) {
  const facts = sponsoredPickOfCard(card);
  const reply = useContext(SceneReplyContext);
  const [folded, setFolded] = useState(false);
  if (!facts) return <p className="ade-sponsored-text">{card.fallbackText}</p>;
  if (folded) {
    return (
      <p className="ade-sponsored-folded">
        Sponsored · {facts.name} <button type="button" className="ade-sponsored-link" onClick={() => setFolded(false)}>Show</button>
      </p>
    );
  }
  return (
    <section className="ade-sponsored" aria-label={`Sponsored recommendation: ${facts.name}`}>
      <div className="ade-sponsored-head">
        <span className="ade-sponsored-mark" aria-hidden>{facts.name.slice(0, 1).toUpperCase()}</span>
        <span className="ade-sponsored-brand">{facts.name}</span>
        <span className="ade-sponsored-label">Sponsored{facts.category ? ` · ${facts.category}` : ""}</span>
      </div>
      {facts.description ? <p className="ade-sponsored-text">{facts.description}</p> : null}
      {facts.need ? <p className="ade-sponsored-need">For: {facts.need}</p> : null}
      <div className="ade-sponsored-actions">
        <button type="button" className="ade-sponsored-cta" onClick={() => openExternalUrl(facts.url)}>
          Open site
          <ArrowUpRight size={12} weight="bold" aria-hidden />
        </button>
        {reply ? (
          <button type="button" className="ade-sponsored-cta" onClick={() => reply(sponsoredPickUseText(facts), card.cardId)}>
            Use it
          </button>
        ) : null}
        <button type="button" className="ade-sponsored-link ade-sponsored-link--start" onClick={() => setFolded(true)}>
          Not now
        </button>
        <span className="ade-sponsored-fine">The agent installs nothing unless you ask.</span>
      </div>
    </section>
  );
}
