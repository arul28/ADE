import { Compass, Lightbulb, SquaresFour } from "@phosphor-icons/react";
import { openAdeTips } from "../../onboarding/tips/AdeTipsDialog";
import type { AnnouncementPageProps } from "../announcementPages";
import "./adeTipsAnnouncement.css";

/**
 * Example "What's new" page. Pages are free-form: this one is a hero, three
 * points and a "Try it" button that closes the modal and opens ADE Tips.
 * Copy one as a starting point, or draw something entirely different.
 */
export default function AdeTipsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <article className="ade-wn-tips">
      <header className="ade-wn-tips-hero">
        <span className="ade-wn-tips-eyebrow">New in ADE</span>
        <h2 className="ade-wn-tips-title">
          Everything ADE can do, <em>one line each</em>.
        </h2>
        <p className="ade-wn-tips-lede">
          ADE Tips collects the features worth knowing, plus the suggestions you set aside for later.
        </p>
      </header>
      <ul className="ade-wn-tips-points">
        <li>
          <Lightbulb size={20} weight="duotone" aria-hidden />
          <span>
            <strong>Browse any time.</strong> Help › ADE Tips, the command palette, or the Home widget.
          </span>
        </li>
        <li>
          <SquaresFour size={20} weight="duotone" aria-hidden />
          <span>
            <strong>Suggested for you.</strong> A suggestion you postpone waits there instead of vanishing.
          </span>
        </li>
        <li>
          <Compass size={20} weight="duotone" aria-hidden />
          <span>
            <strong>Tour again.</strong> “Show me around again” replays setup and the guided tour.
          </span>
        </li>
      </ul>
      <div className="ade-wn-tips-cta">
        <button
          type="button"
          className="kit-btn"
          onClick={() => {
            close();
            openAdeTips();
          }}
        >
          Open ADE Tips
        </button>
      </div>
    </article>
  );
}
