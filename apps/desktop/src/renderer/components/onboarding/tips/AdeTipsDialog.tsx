import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Lightbulb, Sparkle, X, type Icon } from "@phosphor-icons/react";
import { Dialog } from "../../ui/dialog";
import { useAppStore } from "../../../state/appStore";
import {
  ADE_TIP_GROUPS,
  runTipAction,
  tipActionAvailable,
  tipsInGroup,
  type AdeTip,
} from "../../../onboarding/adeTips";
import {
  ADE_SUGGESTIONS,
  neverSuggest,
  startPostponedSuggestion,
  usePostponedSuggestions,
  useSuggestionStartable,
  type PostponedSuggestion,
} from "../../../onboarding/adeTipsSuggestions";
import "./adeTips.css";

/**
 * ADE Tips: everything worth knowing, grouped, each with one sentence and a
 * "Try it" that opens the real surface. Suggestions the user postponed with
 * "Not now" sit on top, under "Suggested for you". Opened with `openAdeTips`
 * from the help menu, the home screen's ADE Tips widget and the command
 * palette; `AdeTipsDialogHost` draws it.
 */

const SUGGESTED_ID = "suggested";

type Section = { id: string; label: string; icon: Icon; count: number };

export function AdeTipsDialog({
  open,
  onOpenChange,
  focusTipId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Scroll to this tip and mark it (the home widget's current tip). */
  focusTipId?: string | null;
}) {
  const navigate = useNavigate();
  const hasProject = useAppStore((state) => Boolean(state.project?.rootPath));
  const postponed = usePostponedSuggestions();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sections = useMemo<Section[]>(() => [
    ...(postponed.length > 0 ? [{ id: SUGGESTED_ID, label: "Suggested for you", icon: Sparkle, count: postponed.length }] : []),
    ...ADE_TIP_GROUPS.map((group) => ({ id: group.id, label: group.label, icon: group.icon, count: tipsInGroup(group.id).length })),
  ], [postponed.length]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const tryTip = useCallback((tip: AdeTip) => {
    if (!tip.action) return;
    close();
    runTipAction(tip.action, navigate);
  }, [close, navigate]);

  const scrollToSection = useCallback((id: string) => {
    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(`[data-tips-section="${id}"]`);
    if (!root || !target) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    root.scrollTo({ top: target.offsetTop - 12, behavior: reduce ? "auto" : "smooth" });
    setActiveId(id);
  }, []);

  // Which section the reader is in, for the rail. Read on scroll, once a frame.
  const frameRef = useRef(0);
  const onScroll = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      const root = scrollRef.current;
      if (!root) return;
      const nodes = root.querySelectorAll<HTMLElement>("[data-tips-section]");
      let current: string | null = nodes[0]?.dataset.tipsSection ?? null;
      for (const node of nodes) {
        if (node.offsetTop - root.scrollTop <= 40) current = node.dataset.tipsSection ?? current;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
        current = nodes[nodes.length - 1]?.dataset.tipsSection ?? current;
      }
      setActiveId(current);
    });
  }, []);
  useEffect(() => () => window.cancelAnimationFrame(frameRef.current), []);

  // Opening on a tip: scroll it into the middle of the list.
  useLayoutEffect(() => {
    if (!open) return;
    setActiveId(null);
    if (!focusTipId) return;
    const frame = window.requestAnimationFrame(() => {
      const root = scrollRef.current;
      const row = root?.querySelector<HTMLElement>(`[data-tip-id="${focusTipId}"]`);
      if (!root || !row) return;
      root.scrollTop = Math.max(0, row.offsetTop - root.clientHeight / 2 + row.offsetHeight / 2);
      onScroll();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusTipId, onScroll, open]);

  const current = activeId ?? sections[0]?.id ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="ADE Tips"
      hideHeader
      width={880}
      height="min(640px, 86vh)"
      bodyPadding={false}
      scrollBody={false}
      panelClassName="ade-tips-panel"
    >
      <div className="ade-tips">
        <aside className="ade-tips-rail">
          <div className="ade-tips-brand">
            <span className="ade-tips-brand-mark" aria-hidden><Lightbulb size={15} weight="fill" /></span>
            ADE Tips
          </div>
          <nav className="ade-tips-nav" aria-label="Tip groups">
            {sections.map((section) => {
              const SectionIcon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  aria-current={current === section.id ? "true" : undefined}
                  data-suggested={section.id === SUGGESTED_ID || undefined}
                  onClick={() => scrollToSection(section.id)}
                >
                  <SectionIcon size={14} aria-hidden />
                  <span>{section.label}</span>
                  <span className="kit-num">{section.count}</span>
                </button>
              );
            })}
          </nav>
        </aside>
        <div className="ade-tips-main" ref={scrollRef} onScroll={onScroll}>
          <header className="ade-tips-head">
            <div>
              <h2>Things worth knowing</h2>
              <p>Nothing here is required. Try what looks useful.</p>
            </div>
            <button type="button" className="kit-icon-btn" aria-label="Close ADE Tips" title="Close" onClick={close}>
              <X size={14} />
            </button>
          </header>

          {postponed.length > 0 ? (
            <section className="ade-tips-section" data-tips-section={SUGGESTED_ID} aria-label="Suggested for you">
              <h3 className="kit-eyebrow">Suggested for you</h3>
              <div className="ade-tips-panel-rows" data-suggested="true">
                {postponed.map((entry) => (
                  <SuggestedRow key={`${entry.id}:${entry.scopeKey}`} entry={entry} onStarted={close} />
                ))}
              </div>
            </section>
          ) : null}

          {ADE_TIP_GROUPS.map((group) => (
            <section key={group.id} className="ade-tips-section" data-tips-section={group.id} aria-label={group.label}>
              <h3 className="kit-eyebrow">{group.label}</h3>
              <div className="ade-tips-panel-rows">
                {tipsInGroup(group.id).map((tip) => (
                  <TipRow
                    key={tip.id}
                    tip={tip}
                    focused={tip.id === focusTipId}
                    canTry={tipActionAvailable(tip.action, { hasProject })}
                    onTry={() => tryTip(tip)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function TipRow({ tip, focused, canTry, onTry }: { tip: AdeTip; focused: boolean; canTry: boolean; onTry: () => void }) {
  const TipIcon = tip.icon;
  return (
    <div className="ade-tips-row" data-tip-id={tip.id} data-focused={focused || undefined}>
      <span className="ade-tips-glyph" aria-hidden><TipIcon size={16} /></span>
      <div className="ade-tips-text">
        <span className="ade-tips-title">{tip.title}</span>
        <span className="ade-tips-sentence">{tip.sentence}</span>
      </div>
      {canTry ? (
        <button type="button" className="kit-btn kit-btn-ghost ade-tips-try" data-size="sm" onClick={onTry} aria-label={`Try ${tip.title}`}>
          Try it <ArrowRight size={11} weight="bold" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function SuggestedRow({ entry, onStarted }: { entry: PostponedSuggestion; onStarted: () => void }) {
  const definition = ADE_SUGGESTIONS[entry.id];
  const startable = useSuggestionStartable(entry.id, entry.scopeKey);
  const SuggestionIcon = definition.icon;
  return (
    <div className="ade-tips-row" data-suggested="true">
      <span className="ade-tips-glyph" aria-hidden><SuggestionIcon size={16} /></span>
      <div className="ade-tips-text">
        <span className="ade-tips-title">{definition.title}</span>
        <span className="ade-tips-sentence">{definition.why}</span>
        <span className="ade-tips-suggested-foot">
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
        </span>
      </div>
    </div>
  );
}

const OPEN_ADE_TIPS_EVENT = "ade:open-ade-tips";

/** Opens ADE Tips from anywhere (help menu, home widget, command palette). */
export function openAdeTips(focusTipId?: string | null): void {
  window.dispatchEvent(new CustomEvent<string | null>(OPEN_ADE_TIPS_EVENT, { detail: focusTipId ?? null }));
}

/** The one ADE Tips dialog, mounted once in the app shell. Renders nothing until opened. */
export function AdeTipsDialogHost() {
  const [request, setRequest] = useState<{ focusTipId: string | null } | null>(null);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<string | null>).detail;
      setRequest({ focusTipId: typeof detail === "string" ? detail : null });
    };
    window.addEventListener(OPEN_ADE_TIPS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ADE_TIPS_EVENT, onOpen);
  }, []);
  if (!request) return null;
  return (
    <AdeTipsDialog
      open
      onOpenChange={(next) => {
        if (!next) setRequest(null);
      }}
      focusTipId={request.focusTipId}
    />
  );
}
