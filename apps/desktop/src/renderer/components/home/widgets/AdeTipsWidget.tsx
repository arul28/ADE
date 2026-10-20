import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CaretLeft, CaretRight, Lightbulb } from "@phosphor-icons/react";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { useAppStore } from "../../../state/appStore";
import { ADE_TIPS, adeTipGroup, runTipAction, tipActionAvailable, tipIndexForDay } from "../../../onboarding/adeTips";
import { openAdeTips } from "../../onboarding/tips/AdeTipsDialog";
import { useWidgetPreview } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { useLocalDayStart } from "./widgetHooks";
import "../homeWidgets.css";
import "../../onboarding/tips/adeTips.css";

/**
 * One ADE tip at a time. Today's tip is picked from the date, so it holds all
 * day and changes tomorrow; the arrows step through the rest. "All tips" opens
 * the ADE Tips dialog on the tip showing here. No reads and no timers of its
 * own beyond the day turning over.
 */
export default function AdeTipsWidget({ item }: HomeWidgetProps) {
  const navigate = useNavigate();
  const preview = useWidgetPreview();
  const hasProject = useAppStore((state) => Boolean(state.project?.rootPath));
  const dayStart = useLocalDayStart();
  const [step, setStep] = useState(0);

  const count = ADE_TIPS.length;
  const index = (((tipIndexForDay(dayStart, count) + step) % count) + count) % count;
  const tip = ADE_TIPS[index]!;
  const TipIcon = tip.icon;
  const canTry = !preview && tipActionAvailable(tip.action, { hasProject });

  return (
    <section className="kit-card ade-home-card ade-tipw" aria-label="ADE Tips" data-size={item.size}>
      <WelcomeCardHead icon={Lightbulb} title="ADE Tips" action={preview ? null : { label: "All tips", onClick: () => openAdeTips(tip.id) }} />
      <div className="kit-card-body ade-tipw-body">
        <div className="ade-tipw-tip" aria-live="polite">
          <span className="ade-tipw-glyph" aria-hidden><TipIcon size={18} /></span>
          <div className="ade-tipw-text">
            <span className="kit-eyebrow">{adeTipGroup(tip.group).label}</span>
            <span className="ade-tipw-title">{tip.title}</span>
            <span className="ade-tipw-sentence" title={tip.sentence}>{tip.sentence}</span>
          </div>
        </div>
        <div className="ade-tipw-foot">
          {canTry && tip.action ? (
            <button type="button" className="kit-btn" data-size="sm" onClick={() => runTipAction(tip.action!, navigate)}>
              Try it <ArrowRight size={11} weight="bold" aria-hidden />
            </button>
          ) : null}
          <div className="ade-tipw-nav">
            <button type="button" className="kit-icon-btn" aria-label="Previous tip" title="Previous tip" disabled={preview} onClick={() => setStep((value) => value - 1)}>
              <CaretLeft size={12} weight="bold" />
            </button>
            <span className="kit-num" aria-label={`Tip ${index + 1} of ${count}`}>{index + 1} / {count}</span>
            <button type="button" className="kit-icon-btn" aria-label="Next tip" title="Next tip" disabled={preview} onClick={() => setStep((value) => value + 1)}>
              <CaretRight size={12} weight="bold" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
