import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Sparkle, X, type Icon } from "@phosphor-icons/react";
import { Dialog } from "../../ui/dialog";
import { useAppStore } from "../../../state/appStore";
import {
  ADE_TIP_GROUPS,
  ADE_TIPS,
  runTipAction,
  tipActionAvailable,
  tipsInGroup,
  type AdeTip,
  type AdeTipGroupId,
} from "../../../onboarding/adeTips";
import {
  ADE_SUGGESTIONS,
  neverSuggest,
  startPostponedSuggestion,
  usePostponedSuggestions,
  useSuggestionStartable,
  type PostponedSuggestion,
} from "../../../onboarding/adeTipsSuggestions";
import { AdeTourCursorArt } from "../tour/AdeTourCursorArt";
import { useGoTo } from "../spotlight/useGoTo";
import { markTipTried, setTipCardsOff, tipCardsOff, useSuggestionRulesVersion } from "../../../onboarding/situationalSuggestions";
import "./adeTips.css";

/**
 * ADE Tips: everything worth knowing, one group at a time, laid out as a wall
 * of tiles in the landing page's manner (sizes and order in `adeTips.ts`): the group's own
 * tile, its headline features as large tiles with a screenshot of the real
 * app, the rest as icon tiles. Each tip's "Try it" goes to the real place and
 * rings the control there (`spotlight/`). Suggestions the user postponed with "Not now" get a
 * group of their own, "For you", first and open by default while there are
 * any. Opened with `openAdeTips` from the help menu, the home screen's ADE
 * Tips widget and the command palette; `AdeTipsDialogHost` draws it.
 */

const SUGGESTED_ID = "suggested";

type SectionId = AdeTipGroupId | typeof SUGGESTED_ID;
type Section = { id: SectionId; label: string; blurb: string; icon: Icon; hue: string; count: number };

/** The violet of ADE's cursor and accent, for the "For you" group. */
const SUGGESTED_HUE = "#a78bfa";

const hueStyle = (hue: string) => ({ "--tips-hue": hue }) as CSSProperties;

export function AdeTipsDialog({
  open,
  onOpenChange,
  focusTipId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open on this tip's group and mark it (the home widget's current tip). */
  focusTipId?: string | null;
}) {
  const goTo = useGoTo();
  const hasProject = useAppStore((state) => state.project != null);
  const postponed = usePostponedSuggestions();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<SectionId, HTMLButtonElement>());
  /** Focus lands on the open group's chip, not the close button. */
  const selectedTabRef = useRef<HTMLElement | null>(null);

  const sections = useMemo<Section[]>(() => [
    ...(postponed.length > 0
      ? [{
        id: SUGGESTED_ID,
        label: "For you",
        blurb: "Ideas ADE had while you worked. You said Not now, so they wait here.",
        icon: Sparkle,
        hue: SUGGESTED_HUE,
        count: postponed.length,
      } satisfies Section]
      : []),
    ...ADE_TIP_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      blurb: group.blurb,
      icon: group.icon,
      hue: group.hue,
      count: tipsInGroup(group.id).length,
    })),
  ], [postponed.length]);

  const [picked, setPicked] = useState<SectionId | null>(() => {
    const focused = focusTipId ? ADE_TIPS.find((tip) => tip.id === focusTipId) : undefined;
    return focused?.group ?? null;
  });
  // The pick, while it is still offered ("For you" goes once its last entry does).
  const active: Section = sections.find((section) => section.id === picked) ?? sections[0]!;

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const tryTip = useCallback((tip: AdeTip) => {
    if (!tip.action) return;
    close();
    markTipTried(tip.id);
    runTipAction(tip.action, goTo, hasProject);
  }, [close, goTo, hasProject]);

  const pick = useCallback((id: SectionId, focus = false) => {
    setPicked(id);
    bodyRef.current?.scrollTo({ top: 0 });
    if (focus) tabRefs.current.get(id)?.focus();
  }, []);

  // Arrow keys move between groups, as in any tab list.
  const onTabKey = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const index = sections.findIndex((section) => section.id === active.id);
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % sections.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + sections.length) % sections.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = sections.length - 1;
    if (next < 0) return;
    event.preventDefault();
    pick(sections[next]!.id, true);
  }, [active.id, pick, sections]);

  // Opening on a tip: bring it into view in its group.
  useLayoutEffect(() => {
    if (!open || !focusTipId) return;
    const cell = bodyRef.current?.querySelector<HTMLElement>(`[data-tip-id="${focusTipId}"]`);
    cell?.scrollIntoView({ block: "nearest" });
  }, [focusTipId, open]);

  const tiles = active.id === SUGGESTED_ID ? [] : tipsInGroup(active.id);
  const ActiveIcon = active.icon;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="ADE Tips"
      hideHeader
      width={1180}
      height="min(840px, 86vh)"
      bodyPadding={false}
      scrollBody={false}
      panelClassName="ade-tips-panel"
      initialFocusRef={selectedTabRef}
    >
      <div className="ade-tips" style={hueStyle(active.hue)}>
        <span className="ade-tips-wash" aria-hidden />
        <header className="ade-tips-head">
          <div className="ade-tips-head-text">
            <span className="ade-tips-eyebrow">ADE Tips</span>
            <h2 className="ade-tips-headline">
              Things worth <em>knowing</em>
            </h2>
            <p className="ade-tips-lede">
              Optional. &ldquo;Try it&rdquo; jumps to the spot.
            </p>
            <TipCardsSwitch />
          </div>
          <button type="button" className="kit-icon-btn ade-tips-close" aria-label="Close ADE Tips" title="Close" onClick={close}>
            <X size={14} />
          </button>
        </header>

        <div className="ade-tips-groups" role="tablist" aria-label="Tip groups" onKeyDown={onTabKey}>
          {sections.map((section) => {
            const SectionIcon = section.icon;
            const selected = section.id === active.id;
            return (
              <button
                key={section.id}
                ref={(node) => {
                  if (node) tabRefs.current.set(section.id, node);
                  else tabRefs.current.delete(section.id);
                  if (node && selected) selectedTabRef.current = node;
                }}
                type="button"
                role="tab"
                id={`ade-tips-tab-${section.id}`}
                aria-selected={selected}
                aria-controls="ade-tips-panel"
                tabIndex={selected ? 0 : -1}
                className="ade-tips-chip"
                data-suggested={section.id === SUGGESTED_ID || undefined}
                style={hueStyle(section.hue)}
                onClick={() => pick(section.id)}
              >
                <SectionIcon size={14} weight={selected ? "fill" : "regular"} aria-hidden />
                <span>{section.label}</span>
                <span className="ade-tips-chip-count">{section.count}</span>
              </button>
            );
          })}
        </div>

        <div
          ref={bodyRef}
          className="ade-tips-body"
          id="ade-tips-panel"
          role="tabpanel"
          aria-labelledby={`ade-tips-tab-${active.id}`}
        >
          {active.id === SUGGESTED_ID ? (
            <>
              <div className="ade-tips-group-head">
                <span className="ade-tips-group-glyph" aria-hidden>
                  <ActiveIcon size={16} weight="duotone" />
                </span>
                <h3 className="ade-tips-group-title">Suggested for you</h3>
                <p className="ade-tips-group-blurb">{active.blurb}</p>
              </div>
              <div className="ade-tips-suggested" key="suggested">
                {postponed.map((entry, index) => (
                  <SuggestedCard key={`${entry.id}:${entry.scopeKey}`} entry={entry} index={index} onStarted={close} />
                ))}
              </div>
            </>
          ) : (
            <div className="ade-tips-wall" key={active.id}>
              <article className="ade-tips-tile" data-size="intro" style={staggerStyle(0)}>
                <span className="ade-tips-intro-glyph" aria-hidden><ActiveIcon size={22} weight="fill" /></span>
                <h3 className="ade-tips-intro-title">{active.label}</h3>
                <p className="ade-tips-intro-blurb">{active.blurb}</p>
                <span className="ade-tips-intro-count">{active.count} {active.count === 1 ? "tip" : "tips"}</span>
              </article>
              {tiles.map((tip, index) => (
                <TipTile
                  key={tip.id}
                  tip={tip}
                  index={index + 1}
                  focused={tip.id === focusTipId}
                  canTry={tipActionAvailable(tip.action)}
                  onTry={() => tryTip(tip)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

const staggerStyle = (index: number) => ({ "--tips-i": Math.min(index, 10) }) as CSSProperties;

function TipTile({
  tip,
  index,
  focused,
  canTry,
  onTry,
}: {
  tip: AdeTip;
  index: number;
  focused: boolean;
  canTry: boolean;
  onTry: () => void;
}) {
  const TipIcon = tip.icon;
  const { shot } = tip;
  const tryButton = canTry ? (
    <button type="button" className="ade-tips-try" onClick={onTry} aria-label={`Try ${tip.title}`}>
      <span className="ade-tips-try-cursor" aria-hidden><AdeTourCursorArt /></span>
      Try it
    </button>
  ) : null;
  if (shot && tip.size === "screen") {
    return (
      <article
        className="ade-tips-tile"
        data-size="screen"
        data-tip-id={tip.id}
        data-focused={focused || undefined}
        data-can-try={canTry || undefined}
        style={staggerStyle(index)}
      >
        <div className="ade-tips-tile-top">
          <span className="ade-tips-tile-icon" aria-hidden><TipIcon size={18} weight="duotone" /></span>
          <h4 className="ade-tips-tile-name">{tip.title}</h4>
          {tryButton}
        </div>
        <p className="ade-tips-tile-headline">{tip.sentence}</p>
        <div className="ade-tips-shot">
          <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" draggable={false} />
        </div>
      </article>
    );
  }
  return (
    <article
      className="ade-tips-tile"
      data-size={tip.size}
      data-shot={shot ? "side" : undefined}
      data-tip-id={tip.id}
      data-focused={focused || undefined}
      data-can-try={canTry || undefined}
      style={staggerStyle(index)}
    >
      <div className="ade-tips-tile-top">
        <span className="ade-tips-tile-icon" data-large="true" aria-hidden><TipIcon size={26} weight="duotone" /></span>
        {tryButton}
      </div>
      <div className="ade-tips-tile-text">
        <h4 className="ade-tips-tile-title">{tip.title}</h4>
        <p className="ade-tips-tile-line">{tip.sentence}</p>
      </div>
      {shot ? (
        <div className="ade-tips-side-shot" aria-hidden>
          <img src={shot.src} alt="" loading="lazy" decoding="async" draggable={false} />
        </div>
      ) : null}
    </article>
  );
}

function SuggestedCard({ entry, index, onStarted }: { entry: PostponedSuggestion; index: number; onStarted: () => void }) {
  const definition = ADE_SUGGESTIONS[entry.id];
  const startable = useSuggestionStartable(entry.id, entry.scopeKey);
  const SuggestionIcon = definition.icon;
  return (
    <article className="ade-tips-suggest" style={staggerStyle(index)}>
      <span className="ade-tips-glyph" aria-hidden><SuggestionIcon size={18} weight="duotone" /></span>
      <div className="ade-tips-suggest-text">
        <h4 className="ade-tips-title">{definition.title}</h4>
        <p className="ade-tips-sentence">{definition.why}</p>
        <div className="ade-tips-suggest-foot">
          {startable ? (
            <button
              type="button"
              className="kit-btn kit-btn-primary"
              data-size="sm"
              onClick={() => {
                onStarted();
                startPostponedSuggestion(entry.id, entry.scopeKey);
              }}
            >
              {definition.actionLabel}
            </button>
          ) : (
            <span className="ade-tips-note">
              {entry.context ? `Open ${entry.context} to start it.` : "Open its project to start it."}
            </span>
          )}
          <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => neverSuggest(entry.id, entry.scopeKey)}>
            Don't suggest again
          </button>
          {startable && entry.context ? <span className="ade-tips-note ade-tips-context">{entry.context}</span> : null}
        </div>
      </div>
    </article>
  );
}

const OPEN_ADE_TIPS_EVENT = "ade:open-ade-tips";

/** Opens ADE Tips from anywhere (help menu, home widget, command palette). */
export function openAdeTips(focusTipId?: string | null): void {
  window.dispatchEvent(new CustomEvent<string | null>(OPEN_ADE_TIPS_EVENT, { detail: focusTipId ?? null }));
}

/** The one ADE Tips dialog, mounted once in the app shell. Renders nothing until opened. */
export function AdeTipsDialogHost() {
  const [request, setRequest] = useState<{ focusTipId: string | null; seq: number } | null>(null);
  useEffect(() => {
    let seq = 0;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<string | null>).detail;
      seq += 1;
      setRequest({ focusTipId: typeof detail === "string" ? detail : null, seq });
    };
    window.addEventListener(OPEN_ADE_TIPS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ADE_TIPS_EVENT, onOpen);
  }, []);
  if (!request) return null;
  return (
    <AdeTipsDialog
      // A second open (another tip from the widget) starts on that tip's group.
      key={request.seq}
      open
      onOpenChange={(next) => {
        if (!next) setRequest(null);
      }}
      focusTipId={request.focusTipId}
    />
  );
}

/** Whether a tip may show on its own now and then (`useFeatureTipCard`). */
function TipCardsSwitch() {
  useSuggestionRulesVersion();
  const off = tipCardsOff();
  return (
    <p className="ade-tips-cards-switch">
      {off ? "Tips stay here." : "Now and then, one you haven't tried shows in the corner."}
      <button type="button" className="ade-tips-cards-switch-btn" onClick={() => setTipCardsOff(!off)}>
        {off ? "Show them now and then" : "Turn off"}
      </button>
    </p>
  );
}
