import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, X } from "@phosphor-icons/react";
import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { isGravityUrl, type CloudSponsoredAd, type CloudSponsoredAdAnswer, type CloudSponsoredConsent, type CloudSponsoredFormat } from "../../../../shared/adeCloud";
import { setCloudSponsoredConsent, useCloudAccount } from "../../../state/cloudAccountStore";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { openExternalUrl } from "../../../lib/openExternal";
import { Button } from "../../ui/Button";
import { holdSponsoredPlace, releaseSponsoredPlace, useOnScreen, useSponsoredPlaceHolder } from "./sponsoredOnScreen";
import { SponsoredOutletsContext, useSponsoredOutlet } from "./sponsoredOutlets";
import { SPONSORED_TURN_FRESH_MS, lastFinishedTurn, sponsoredDevice } from "./sponsoredTurn";
import { useDocumentVisible, useSponsoredViewer } from "./useSponsoredViewer";
import "./sponsored.css";

/**
 * One sponsored card for a finished reply, in a Free-plan chat on an ADE
 * Cloud computer only (`docs/plans/pricing-v2-and-gravity.md`). The server
 * names the format (`CloudSponsoredFormat`): a card under the reply, a card
 * docked above the prompt box, or one linked sentence at the end of the
 * reply. This slot asks for all three; the other two draw into the pane's
 * outlets (`sponsoredOutlets.tsx`), and a pane without them gets the card
 * under the reply. Nothing of a card ever reaches the agent.
 *
 * The account server decides everything (`gravity.ts`): the switch, the plan,
 * the country, the account's answer, and that the chat's computer is one of
 * the account's ADE Cloud computers. This slot only asks at the right moment:
 * a turn finished well, the window is visible, and the place under the reply
 * is on screen. Gravity's view link goes once half of the card is on screen.
 * Nothing here rewards a view or a click.
 *
 * Never mounted in a subagent view, a CLI terminal, the Work list, a
 * notification, or a chat on the person's own machine (no ADE Cloud lane for
 * its pin).
 */

const ANSWER_CACHE_LIMIT = 50;
const NOT_CLOUD_RETRY_MS = 12_000;
/** How long a finished reply's end may take to mount before an inline card goes under the reply instead. */
const INLINE_HOST_WAIT_MS = 1_500;

const answers = new Map<string, Promise<CloudSponsoredAdAnswer>>();
const viewedAds = new Set<string>();
const hiddenTurns = new Set<string>();

function askOnce(key: string, ask: () => Promise<CloudSponsoredAdAnswer>): Promise<CloudSponsoredAdAnswer> {
  const known = answers.get(key);
  if (known) return known;
  const pending = ask()
    .catch((): CloudSponsoredAdAnswer => ({ ad: null, reason: "unavailable" }))
    .then((answer) => {
      // A failed ask (Gravity down, offline) is not the turn's answer: the
      // server freed the turn, so the next look asks again.
      if (answer.reason === "unavailable" && answers.get(key) === pending) answers.delete(key);
      return answer;
    });
  answers.set(key, pending);
  if (answers.size > ANSWER_CACHE_LIMIT) answers.delete(answers.keys().next().value as string);
  return pending;
}

export type SponsoredReplySlotProps = {
  /** The ADE Cloud lane computer the chat runs on (`useAdeCloudLaneForBinding` of its pin); null on the person's own machine. */
  instanceId: string | null;
  sessionId: string | null;
  events: readonly AgentChatEventEnvelope[];
  turnActive: boolean;
  /** The pane is on screen (its tile is visible): a hidden pane neither asks nor counts as watched. */
  paneVisible: boolean;
};

export function SponsoredReplySlot({ instanceId, sessionId, events, turnActive, paneVisible }: SponsoredReplySlotProps) {
  const account = useCloudAccount(Boolean(instanceId && sessionId));
  const sponsored = account?.sponsored;
  if (!instanceId || !sessionId || !sponsored?.ads || sponsored.consent === "declined") return null;
  return (
    <SponsoredReplySlotOn
      instanceId={instanceId}
      sessionId={sessionId}
      events={events}
      turnActive={turnActive}
      paneVisible={paneVisible}
      consent={sponsored.consent}
      test={sponsored.test}
      smallNeedsCards={sponsored.smallNeedsCards === true}
      format={sponsored.format ?? "below_reply"}
    />
  );
}

function SponsoredReplySlotOn({
  instanceId,
  sessionId,
  events,
  turnActive,
  paneVisible,
  consent,
  test,
  smallNeedsCards,
  format,
}: Omit<SponsoredReplySlotProps, "instanceId" | "sessionId"> & {
  instanceId: string;
  sessionId: string;
  consent: CloudSponsoredConsent | null;
  test: boolean;
  smallNeedsCards: boolean;
  format: CloudSponsoredFormat;
}) {
  const visible = useDocumentVisible() && paneVisible;
  // The scan runs only between turns; while one streams there is no card.
  const turn = useMemo(() => (turnActive ? null : lastFinishedTurn(events)), [events, turnActive]);
  const fresh = turn != null && Date.now() - turn.finishedAt < SPONSORED_TURN_FRESH_MS;
  const turnKey = turn ? `${sessionId}:${turn.turnId}` : null;
  const [hidden, setHidden] = useState(() => (turnKey ? hiddenTurns.has(turnKey) : false));
  useEffect(() => setHidden(turnKey ? hiddenTurns.has(turnKey) : false), [turnKey]);

  // The latest finished reply, kept while the next one runs: the docked card stays only if it is that reply's.
  const [lastTurnKey, setLastTurnKey] = useState<string | null>(null);
  useEffect(() => {
    if (turnKey) setLastTurnKey(turnKey);
  }, [turnKey]);

  // Where the card draws: the dock, the reply's end, or (no such place in this pane) under the reply.
  const outlets = useContext(SponsoredOutletsContext);
  const wantedPlace = !outlets || format === "below_reply" ? null : format === "above_prompt" ? "dock" : "inline";
  const target = useSponsoredOutlet(outlets, wantedPlace, turn?.turnId ?? null);
  // A reply that ends without text (a tool call last) has no end to draw into: its card goes under the reply.
  const [noInlineHost, setNoInlineHost] = useState<string | null>(null);
  useEffect(() => {
    if (wantedPlace !== "inline" || target || !turnKey) return;
    const timer = window.setTimeout(() => setNoInlineHost(turnKey), INLINE_HOST_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [wantedPlace, target, turnKey]);
  const place = wantedPlace === "inline" && !target && noInlineHost === turnKey ? null : wantedPlace;
  const shownFormat: CloudSponsoredFormat = place ? format : "below_reply";
  const targetReady = place === null || target !== null;

  // A card shows only while its place is on screen: under the reply (the
  // region, card included), the reply's end (the outlet itself), or the dock,
  // which is on screen while the pane is.
  const regionRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useMemo(() => ({ current: target }), [target]);
  const wanted = fresh && !hidden && visible;
  const onScreen = useOnScreen(regionRef, 0, wanted);
  const targetOnScreen = useOnScreen(targetRef, 0, wanted && place === "inline");
  const seen = place === "dock" ? wanted : place === "inline" ? targetOnScreen : onScreen;

  // Someone is watching this computer's chat: the Index may answer its agents.
  useSponsoredViewer(instanceId, consent === "granted" && visible);

  // One sponsored card on screen in the whole window. A pane whose place
  // another card holds doesn't even ask: its card could never show.
  const slotId = useId();
  const holder = useSponsoredPlaceHolder();
  const placeFree = holder === null || holder === slotId;

  const [ad, setAd] = useState<{ key: string; turnId: string; ad: CloudSponsoredAd } | null>(null);
  // A chat's first reply can be asked about before its computer saved the
  // chat's copy (`not_cloud`): one more ask a little later, never more.
  const [askAgain, setAskAgain] = useState<string | null>(null);
  useEffect(() => {
    if (consent !== "granted" || !wanted || !seen || !targetReady || !placeFree || !turn || !turnKey) return;
    if (ad?.key === turnKey) return;
    const askAd = window.ade?.cloud?.sponsoredAd;
    if (!askAd) return;
    let live = true;
    let timer: number | null = null;
    const input = { instanceId, chatId: sessionId, turnId: turn.turnId, messages: turn.messages, device: sponsoredDevice(), format: shownFormat, surface: "desktop" as const };
    void askOnce(turnKey, () => askAd(input))
      .then((answer) => {
        if (!live) return;
        if (answer.ad && isGravityUrl(answer.ad.clickUrl)) setAd({ key: turnKey, turnId: turn.turnId, ad: answer.ad });
        else if (answer.reason === "not_cloud" && askAgain !== turnKey) {
          timer = window.setTimeout(() => {
            answers.delete(turnKey);
            setAskAgain(turnKey);
          }, NOT_CLOUD_RETRY_MS);
        }
      });
    return () => {
      live = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [consent, wanted, seen, targetReady, placeFree, turn, turnKey, ad?.key, instanceId, sessionId, askAgain, shownFormat]);

  const adShown = ad !== null && ad.key === turnKey;
  let showing: "consent" | "ad" | null = null;
  // The question is always asked under the reply.
  if (wanted && onScreen && consent === null) showing = "consent";
  else if (wanted && seen && adShown && targetReady) showing = "ad";
  // The docked card stays while the next reply runs, and gives way to that reply's own.
  else if (place === "dock" && turnActive && target && visible && ad && ad.key === lastTurnKey && !hiddenTurns.has(ad.key)) showing = "ad";

  useEffect(() => {
    if (showing) holdSponsoredPlace(slotId);
    else releaseSponsoredPlace(slotId);
  }, [showing, slotId, holder]);
  useEffect(() => () => releaseSponsoredPlace(slotId), [slotId]);
  const holds = holder === slotId;

  const hide = () => {
    if (!ad) return;
    hiddenTurns.add(ad.key);
    setHidden(true);
    // Counted once per reply for the formats' A/B test; nothing else is sent.
    void window.ade?.cloud?.sponsoredHide?.({ chatId: sessionId, turnId: ad.turnId }).catch(() => undefined);
  };

  let card: React.ReactNode = null;
  if (holds && showing === "ad" && ad) {
    if (shownFormat === "inline") card = <SponsoredInlineLine ad={ad.ad} test={test} onHide={hide} />;
    else if (shownFormat === "above_prompt") card = <SponsoredDockCard ad={ad.ad} test={test} onHide={hide} />;
    else card = <SponsoredAdCard ad={ad.ad} test={test} onHide={hide} />;
  }

  return (
    <div ref={regionRef} className="w-full max-w-[var(--chat-content-width,52rem)]">
      <div aria-hidden className="h-px w-full" />
      {holds && showing === "consent" ? <SponsoredConsentCard smallNeedsCards={smallNeedsCards} format={shownFormat} /> : null}
      {card && target ? createPortal(card, target) : card}
    </div>
  );
}

/** Where each format shows, as the one-time question says it. */
const FORMAT_PLACE: Record<CloudSponsoredFormat, string> = {
  below_reply: "one sponsored card under a finished reply",
  above_prompt: "one sponsored card above the prompt box after a finished reply",
  inline: "one sponsored line at the end of a finished reply",
};

/**
 * The one-time question. While the server's `smallNeedsCards` rule is on, a
 * no has Free's Small computers use hours, so the card says that up front.
 */
function SponsoredConsentCard({ smallNeedsCards, format }: { smallNeedsCards: boolean; format: CloudSponsoredFormat }) {
  const [busy, setBusy] = useState(false);
  const answer = (consent: CloudSponsoredConsent) => {
    setBusy(true);
    void setCloudSponsoredConsent(consent)
      .catch((error: unknown) => showToast({ tone: "error", title: "Couldn't save your answer", message: ipcErrorMessage(error) || "Try again in a moment." }))
      .finally(() => setBusy(false));
  };
  return (
    <section className="ade-sponsored" aria-label="Sponsored cards on ADE Cloud Free">
      <div className="ade-sponsored-head">
        <span className="ade-sponsored-label">ADE Cloud Free</span>
      </div>
      <p className="ade-sponsored-title">{smallNeedsCards ? "Keep Small computers unlimited" : "Free cloud chats are ad-supported"}</p>
      <p className="ade-sponsored-text">
        {smallNeedsCards
          ? `Free shows ${FORMAT_PLACE[format]} in ADE Cloud chats. Without them, Small computers use your hours, half an hour for each hour awake. An agent may also recommend a sponsored tool.`
          : `A Free chat on ADE Cloud can show ${FORMAT_PLACE[format]}, and an agent may recommend a sponsored tool.`}{" "}
        To pick them, ADE sends Gravity, our ad partner, your last message and the reply (or the
        agent's search), your IP address, your device type and a hashed copy of your account email. Sponsored cards
        are for people 18 or older. You can change this in Settings › ADE Cloud.
      </p>
      <div className="ade-sponsored-actions">
        <Button size="sm" casing="sentence" variant="outline" disabled={busy} onClick={() => answer("granted")}>
          Show sponsored cards
        </Button>
        <Button size="sm" casing="sentence" variant="outline" disabled={busy} onClick={() => answer("declined")}>
          {smallNeedsCards ? "No thanks, use my hours" : "No thanks"}
        </Button>
        <button type="button" className="ade-sponsored-link" onClick={() => openExternalUrl("https://ade-app.dev/privacy#sponsored")}>
          How it works
        </button>
      </div>
    </section>
  );
}

type SponsoredCardProps = { ad: CloudSponsoredAd; test: boolean; onHide: () => void };

/** Gravity's view link, once, when half of the card is on screen in a visible window. Returns the card's opener. */
function useSponsoredView(ref: React.RefObject<HTMLElement | null>, ad: CloudSponsoredAd): () => void {
  const visible = useDocumentVisible();
  const halfOnScreen = useOnScreen(ref, 0.5, true);
  useEffect(() => {
    if (!halfOnScreen || !visible || !ad.impUrl || viewedAds.has(ad.id)) return;
    viewedAds.add(ad.id);
    const sent = window.ade?.cloud?.sponsoredViewed?.(ad.impUrl);
    // Not delivered (offline): the next time half the card is on screen sends it again.
    void sent?.then((delivered) => {
      if (!delivered) viewedAds.delete(ad.id);
    }, () => viewedAds.delete(ad.id));
  }, [halfOnScreen, visible, ad.id, ad.impUrl]);
  return () => {
    if (isGravityUrl(ad.clickUrl)) openExternalUrl(ad.clickUrl);
  };
}

const sponsoredLabel = (test: boolean, ad: CloudSponsoredAd) => (test || ad.test ? "Sponsored · test" : "Sponsored");

function SponsoredHide({ onHide, label }: { onHide: () => void; label: string }) {
  return (
    <button type="button" className="ade-sponsored-hide" aria-label={label} title="Hide" onClick={onHide}>
      <X size={12} weight="bold" />
    </button>
  );
}

/** One linked sentence at the end of the reply: the ad's text, marked Sponsored. */
function SponsoredInlineLine({ ad, test, onHide }: SponsoredCardProps) {
  const lineRef = useRef<HTMLParagraphElement | null>(null);
  const open = useSponsoredView(lineRef, ad);
  return (
    <p ref={lineRef} className="ade-sponsored-inline" aria-label={`Sponsored: ${ad.brand}`}>
      <span className="ade-sponsored-inline-tag">{sponsoredLabel(test, ad)} · {ad.brand}</span>
      <button type="button" className="ade-sponsored-inline-link" onClick={open}>
        {ad.text}
        <ArrowUpRight size={11} weight="bold" aria-hidden />
      </button>
      <SponsoredHide onHide={onHide} label="Hide this sponsored line" />
    </p>
  );
}

/** A one-row card docked above the prompt box: the latest reply's. */
function SponsoredDockCard({ ad, test, onHide }: SponsoredCardProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const open = useSponsoredView(cardRef, ad);
  return (
    <section ref={cardRef} className="ade-sponsored ade-sponsored--dock" aria-label={`Sponsored: ${ad.brand}`}>
      <span className="ade-sponsored-mark" aria-hidden>{ad.brand.slice(0, 1).toUpperCase()}</span>
      <div className="ade-sponsored-dock-copy">
        <div className="ade-sponsored-head">
          <span className="ade-sponsored-brand">{ad.brand}</span>
          <span className="ade-sponsored-label">{sponsoredLabel(test, ad)}</span>
        </div>
        <button type="button" className="ade-sponsored-dock-line" onClick={open} title={`${ad.title} — ${ad.text}`}>
          <span className="ade-sponsored-dock-title">{ad.title}</span>
          <span className="ade-sponsored-dock-text"> — {ad.text}</span>
        </button>
      </div>
      <button type="button" className="ade-sponsored-cta" onClick={open}>
        {ad.cta ?? "Learn more"}
        <ArrowUpRight size={12} weight="bold" aria-hidden />
      </button>
      <SponsoredHide onHide={onHide} label="Hide this card" />
    </section>
  );
}

function SponsoredAdCard({ ad, test, onHide }: SponsoredCardProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const open = useSponsoredView(cardRef, ad);
  return (
    <section ref={cardRef} className="ade-sponsored" aria-label={`Sponsored: ${ad.brand}`}>
      <div className="ade-sponsored-head">
        <span className="ade-sponsored-mark" aria-hidden>{ad.brand.slice(0, 1).toUpperCase()}</span>
        <span className="ade-sponsored-brand">{ad.brand}</span>
        <span className="ade-sponsored-label">{sponsoredLabel(test, ad)}</span>
        <SponsoredHide onHide={onHide} label="Hide this card" />
      </div>
      <button type="button" className="ade-sponsored-title ade-sponsored-open" onClick={open}>
        {ad.title}
      </button>
      <p className="ade-sponsored-text">{ad.text}</p>
      <div className="ade-sponsored-actions ade-sponsored-actions--end">
        <button type="button" className="ade-sponsored-cta" onClick={open}>
          {ad.cta ?? "Learn more"}
          <ArrowUpRight size={12} weight="bold" aria-hidden />
        </button>
      </div>
    </section>
  );
}
