import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, X } from "@phosphor-icons/react";
import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { isGravityUrl, type CloudSponsoredAd, type CloudSponsoredAdAnswer, type CloudSponsoredConsent, type CloudSponsoredFormat } from "../../../../shared/adeCloud";
import { noteSponsoredNoticeShown, setCloudSponsoredConsent, useCloudAccount } from "../../../state/cloudAccountStore";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { openExternalUrl } from "../../../lib/openExternal";
import { Button } from "../../ui/Button";
import { holdSponsoredPlace, releaseSponsoredPlace, useOnScreen, useSponsoredPlaceHolder } from "./sponsoredOnScreen";
import { SponsoredGravityCard, type SponsoredGravityPlace } from "./SponsoredGravityCard";
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
/** Gravity's viewability rule: half of the card on screen for a full second. */
const SPONSORED_VIEWABLE_MS = 1_000;

/** One of a card's Gravity links, once per key. Not delivered (offline): the next look at the card sends it again. */
function sendSponsoredLink(key: string, url: string | null): void {
  if (!url || viewedAds.has(key)) return;
  viewedAds.add(key);
  void window.ade?.cloud?.sponsoredViewed?.(url)?.then((delivered) => {
    if (!delivered) viewedAds.delete(key);
  }, () => viewedAds.delete(key));
}

/** The card's view link with Gravity's viewability event, named as ADE's own renderer (Gravity's renderers send `sdk`/`sv` too). */
function sponsoredViewabilityUrl(impUrl: string, ev: "measured" | "viewable"): string | null {
  try {
    const url = new URL(impUrl);
    url.searchParams.append("ev", ev);
    url.searchParams.append("sdk", "ade-js");
    url.searchParams.append("sv", "1");
    return url.toString();
  } catch {
    return null; // Never: the server sends only Gravity's own https links.
  }
}
const hiddenTurns = new Set<string>();
/**
 * Replies that showed the notice that cards are on (`startsOn`): false while
 * it shows, true once the person dismissed it. That reply asks for no card:
 * the notice holds its place.
 */
const noticeTurns = new Map<string, boolean>();
/** Replies whose inline card went under the reply (no end to draw into): kept for the run, so a remount asks and draws the same. */
const belowReplyTurns = new Set<string>();
/**
 * The format each reply's card was asked in. A reply keeps it for the run,
 * through a format change or a remount: its card's placement (and the inline
 * length limit) came with that ask. A new format applies to later replies.
 */
const askedFormats = new Map<string, CloudSponsoredFormat>();

function noteAsked(turnKey: string, format: CloudSponsoredFormat): void {
  if (askedFormats.has(turnKey)) return;
  askedFormats.set(turnKey, format);
  if (askedFormats.size > ANSWER_CACHE_LIMIT) askedFormats.delete(askedFormats.keys().next().value as string);
}

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
      startsOn={sponsored.startsOn === true}
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
  startsOn,
  test,
  smallNeedsCards,
  format,
}: Omit<SponsoredReplySlotProps, "instanceId" | "sessionId"> & {
  instanceId: string;
  sessionId: string;
  consent: CloudSponsoredConsent | null;
  /** Cards start on for this person: the notice that they are on shows instead of the question. */
  startsOn: boolean;
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
  const [notice, setNotice] = useState(() => (turnKey ? noticeTurns.get(turnKey) : undefined));
  useEffect(() => setNotice(turnKey ? noticeTurns.get(turnKey) : undefined), [turnKey]);

  // The latest finished reply, kept while the next one runs: the docked card stays only if it is that reply's.
  const [lastTurnKey, setLastTurnKey] = useState<string | null>(null);
  useEffect(() => {
    if (turnKey) setLastTurnKey(turnKey);
  }, [turnKey]);

  // Where the card draws: the dock, the reply's end, or (no such place in this pane) under the reply.
  const outlets = useContext(SponsoredOutletsContext);
  const turnFormat = (turnKey ? askedFormats.get(turnKey) : undefined) ?? format;
  const wantedPlace = !outlets || turnFormat === "below_reply" ? null : turnFormat === "above_prompt" ? "dock" : "inline";
  const target = useSponsoredOutlet(outlets, wantedPlace, turn?.turnId ?? null);
  // A reply that ends without text (a tool call last) has no end to draw into: its card goes under the
  // reply, and stays there even if an end mounts later (the card was asked for that placement).
  const [noInlineHost, setNoInlineHost] = useState<string | null>(null);
  useEffect(() => {
    // Only before the reply asked: an inline card already asked for waits for its end to scroll back in.
    if (wantedPlace !== "inline" || target || !turnKey || belowReplyTurns.has(turnKey) || askedFormats.has(turnKey)) return;
    const timer = window.setTimeout(() => {
      belowReplyTurns.add(turnKey);
      if (belowReplyTurns.size > ANSWER_CACHE_LIMIT) belowReplyTurns.delete(belowReplyTurns.values().next().value as string);
      setNoInlineHost(turnKey);
    }, INLINE_HOST_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [wantedPlace, target, turnKey]);
  const fellBack = turnKey !== null && (noInlineHost === turnKey || belowReplyTurns.has(turnKey));
  const place = wantedPlace === "inline" && fellBack ? null : wantedPlace;
  const shownFormat: CloudSponsoredFormat = place ? turnFormat : "below_reply";
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

  const [ad, setAd] = useState<{ key: string; turnId: string; format: CloudSponsoredFormat; ad: CloudSponsoredAd } | null>(null);
  // A chat's first reply can be asked about before its computer saved the
  // chat's copy (`not_cloud`): one more ask a little later, never more.
  const [askAgain, setAskAgain] = useState<string | null>(null);
  useEffect(() => {
    if (consent !== "granted" || notice !== undefined || !wanted || !seen || !targetReady || !placeFree || !turn || !turnKey) return;
    if (ad?.key === turnKey) return;
    const askAd = window.ade?.cloud?.sponsoredAd;
    if (!askAd) return;
    let live = true;
    let timer: number | null = null;
    noteAsked(turnKey, shownFormat);
    const askedFormat = askedFormats.get(turnKey) ?? shownFormat;
    const input = { instanceId, chatId: sessionId, turnId: turn.turnId, messages: turn.messages, device: sponsoredDevice(), format: askedFormat, surface: "desktop" as const, renderer: "web1" as const };
    void askOnce(turnKey, () => askAd(input))
      .then((answer) => {
        if (!live) return;
        if (answer.ad && isGravityUrl(answer.ad.clickUrl)) setAd({ key: turnKey, turnId: turn.turnId, format: askedFormat, ad: answer.ad });
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
  }, [consent, notice, wanted, seen, targetReady, placeFree, turn, turnKey, ad?.key, instanceId, sessionId, askAgain, shownFormat]);

  const adShown = ad !== null && ad.key === turnKey && ad.format === shownFormat;
  // Where cards start on, the person is told instead of asked; the notice stays on its reply
  // (after saving it made the answer a yes) until dismissed. A turned-off notice unmounts the slot.
  const told = startsOn && consent === null;
  const noticeShowing = notice === undefined ? told : notice === false && (told || consent === "granted");
  const asking = consent === null && !startsOn && notice !== true;
  let showing: "consent" | "ad" | null = null;
  // The question and the notice are always under the reply.
  if (wanted && onScreen && (asking || noticeShowing)) showing = "consent";
  else if (wanted && seen && adShown && targetReady) showing = "ad";
  // The docked card stays while the next reply runs, and gives way to that reply's own.
  else if (place === "dock" && turnActive && target && visible && ad && ad.format === "above_prompt" && ad.key === lastTurnKey && !hiddenTurns.has(ad.key)) showing = "ad";

  useEffect(() => {
    if (showing) holdSponsoredPlace(slotId);
    else releaseSponsoredPlace(slotId);
  }, [showing, slotId, holder]);
  useEffect(() => () => releaseSponsoredPlace(slotId), [slotId]);
  const holds = holder === slotId;

  // The notice, shown: saved once (so cards and free Small follow on every machine), and kept on this reply.
  useEffect(() => {
    if (!holds || showing !== "consent" || !told || !turnKey) return;
    if (!noticeTurns.has(turnKey)) {
      noticeTurns.set(turnKey, false);
      if (noticeTurns.size > ANSWER_CACHE_LIMIT) noticeTurns.delete(noticeTurns.keys().next().value as string);
      setNotice(false);
    }
    noteSponsoredNoticeShown();
  }, [holds, showing, told, turnKey]);
  const dismissNotice = () => {
    if (!turnKey) return;
    noticeTurns.set(turnKey, true);
    setNotice(true);
  };

  const hide = () => {
    if (!ad) return;
    hiddenTurns.add(ad.key);
    setHidden(true);
    // Counted once per reply for the formats' A/B test; nothing else is sent.
    void window.ade?.cloud?.sponsoredHide?.({ chatId: sessionId, turnId: ad.turnId }).catch(() => undefined);
  };

  let card: React.ReactNode = null;
  const gravityAd = ad?.ad.gravity;
  if (holds && showing === "ad" && ad) {
    if (ad.format === "inline") {
      // The inline format is ADE's own linked sentence at the reply's end, never a card.
      card = <SponsoredInlineLine ad={ad.ad} test={test} onHide={hide} />;
    } else if (gravityAd && isGravityUrl(gravityAd.clickUrl)) {
      // Gravity's own renderer and design, in the card's place.
      card = <SponsoredGravityCard ad={gravityAd} place={GRAVITY_PLACE[ad.format]} brand={ad.ad.brand} onHide={hide} />;
    } else if (ad.format === "above_prompt") {
      // An answer without Gravity's ad (an older account server): ADE's own card.
      card = <SponsoredDockCard ad={ad.ad} test={test} onHide={hide} />;
    } else {
      card = <SponsoredAdCard ad={ad.ad} test={test} onHide={hide} />;
    }
  }

  return (
    <div ref={regionRef} className="w-full max-w-[var(--chat-content-width,52rem)]">
      <div aria-hidden className="h-px w-full" />
      {holds && showing === "consent" ? (
        <SponsoredConsentCard smallNeedsCards={smallNeedsCards} format={shownFormat} notice={noticeShowing} onDismiss={dismissNotice} />
      ) : null}
      {card && place && target ? createPortal(card, target) : card}
    </div>
  );
}

const GRAVITY_PLACE: Record<Exclude<CloudSponsoredFormat, "inline">, SponsoredGravityPlace> = {
  below_reply: "below_response",
  above_prompt: "bottom_page",
};

/** Where each format shows, as the one-time question says it. */
const FORMAT_PLACE: Record<CloudSponsoredFormat, string> = {
  below_reply: "one sponsored card under a finished reply",
  above_prompt: "one sponsored card above the prompt box after a finished reply",
  inline: "one sponsored line at the end of a finished reply",
};

/**
 * The one-time question, or, where cards start on (`startsOn`), the notice
 * that they are on with Turn off beside it. While the server's
 * `smallNeedsCards` rule is on, a no has Free's Small computers use credits,
 * so both say that on a line of its own.
 */
function SponsoredConsentCard({ smallNeedsCards, format, notice, onDismiss }: {
  smallNeedsCards: boolean;
  format: CloudSponsoredFormat;
  notice: boolean;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (consent: CloudSponsoredConsent) => {
    setBusy(true);
    void setCloudSponsoredConsent(consent)
      .catch((error: unknown) => showToast({ tone: "error", title: "Couldn't save your answer", message: ipcErrorMessage(error) || "Try again in a moment." }))
      .finally(() => setBusy(false));
  };
  const what = `Free ADE Cloud chats show ${FORMAT_PLACE[format]}, and an agent may recommend a sponsored tool.`;
  return (
    <section className="ade-sponsored" aria-label="Sponsored cards on ADE Cloud Free">
      <div className="ade-sponsored-head">
        <span className="ade-sponsored-label">ADE Cloud Free</span>
      </div>
      <p className="ade-sponsored-title">
        {notice ? "Sponsored cards are on" : smallNeedsCards ? "Keep Small computers free" : "Free cloud chats are ad-supported"}
      </p>
      <p className="ade-sponsored-text">
        {what}{notice && smallNeedsCards ? " They keep Small computers free." : ""} {SPONSORED_SENDS}
      </p>
      <p className="ade-sponsored-cost">
        {smallNeedsCards ? `${notice ? "Turn them off" : "Say no"} and Small computers use your credits, half a credit for each hour awake. ` : null}
        You can change this in Settings › ADE Cloud.
      </p>
      <div className="ade-sponsored-actions">
        {notice ? (
          <>
            <Button size="sm" casing="sentence" variant="primary" disabled={busy} onClick={onDismiss}>
              Got it
            </Button>
            <Button size="sm" casing="sentence" variant="outline" disabled={busy} onClick={() => answer("declined")}>
              {smallNeedsCards ? "Turn off, use my credits" : "Turn off"}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" casing="sentence" variant="primary" disabled={busy} onClick={() => answer("granted")}>
              Show sponsored cards
            </Button>
            <Button size="sm" casing="sentence" variant="outline" disabled={busy} onClick={() => answer("declined")}>
              {smallNeedsCards ? "No thanks, use my credits" : "No thanks"}
            </Button>
          </>
        )}
        <button type="button" className="ade-sponsored-link" onClick={() => openExternalUrl("https://ade-app.dev/privacy#sponsored")}>
          How it works
        </button>
      </div>
    </section>
  );
}

/** What Gravity gets, as the question, the notice and Settings say it. */
const SPONSORED_SENDS =
  "To pick them, ADE sends Gravity, our ad partner, your last message and the reply (or the agent's search), your IP address, your device type and a hashed copy of your account email. Sponsored cards are for people 18 or older.";

type SponsoredCardProps = { ad: CloudSponsoredAd; test: boolean; onHide: () => void };

/**
 * Gravity's view link and viewability links, as Gravity's own renderer sends
 * them: once half of the card is on screen in a visible window, the view link
 * and `ev=measured`; after a full second of that, `ev=viewable`. Each once per
 * card. Returns the card's opener.
 */
function useSponsoredView(ref: React.RefObject<HTMLElement | null>, ad: CloudSponsoredAd): () => void {
  const visible = useDocumentVisible();
  const halfOnScreen = useOnScreen(ref, 0.5, true);
  useEffect(() => {
    const impUrl = ad.impUrl;
    if (!halfOnScreen || !visible || !impUrl) return;
    sendSponsoredLink(ad.id, impUrl);
    sendSponsoredLink(`${ad.id} measured`, sponsoredViewabilityUrl(impUrl, "measured"));
    if (viewedAds.has(`${ad.id} viewable`)) return;
    // Scrolled away, or the window hidden, before the second is up: no viewable link yet.
    const timer = window.setTimeout(() => sendSponsoredLink(`${ad.id} viewable`, sponsoredViewabilityUrl(impUrl, "viewable")), SPONSORED_VIEWABLE_MS);
    return () => window.clearTimeout(timer);
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
      {/* A link, not a button: a button never breaks across lines, so a long ad would drop to a row of its own. */}
      <a
        href={ad.clickUrl}
        className="ade-sponsored-inline-link"
        onClick={(event) => {
          event.preventDefault();
          open();
        }}
      >
        {ad.text}
        <ArrowUpRight size={11} weight="bold" aria-hidden />
      </a>
      <SponsoredHide onHide={onHide} label="Hide this sponsored line" />
    </p>
  );
}

/**
 * A card's top row: who, that it's sponsored, and on the right its call to
 * action and the hide button, so the ad's text below gets the card's width.
 */
function SponsoredCardHead({ ad, test, open, onHide }: SponsoredCardProps & { open: () => void }) {
  return (
    <div className="ade-sponsored-head">
      <span className="ade-sponsored-mark" aria-hidden>{ad.brand.slice(0, 1).toUpperCase()}</span>
      <span className="ade-sponsored-brand">{ad.brand}</span>
      <span className="ade-sponsored-label">{sponsoredLabel(test, ad)}</span>
      <button type="button" className="ade-sponsored-cta" onClick={open}>
        {ad.cta ?? "Learn more"}
        <ArrowUpRight size={12} weight="bold" aria-hidden />
      </button>
      <SponsoredHide onHide={onHide} label="Hide this card" />
    </div>
  );
}

/** The card docked above the prompt box (the latest reply's): the ad as one line that wraps, never cut off. */
function SponsoredDockCard({ ad, test, onHide }: SponsoredCardProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const open = useSponsoredView(cardRef, ad);
  return (
    <section ref={cardRef} className="ade-sponsored ade-sponsored--dock" aria-label={`Sponsored: ${ad.brand}`}>
      <SponsoredCardHead ad={ad} test={test} open={open} onHide={onHide} />
      <button type="button" className="ade-sponsored-dock-line" onClick={open}>
        <span className="ade-sponsored-dock-title">{ad.title}</span>
        {ad.text ? <span className="ade-sponsored-dock-text"> — {ad.text}</span> : null}
      </button>
    </section>
  );
}

function SponsoredAdCard({ ad, test, onHide }: SponsoredCardProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const open = useSponsoredView(cardRef, ad);
  return (
    <section ref={cardRef} className="ade-sponsored" aria-label={`Sponsored: ${ad.brand}`}>
      <SponsoredCardHead ad={ad} test={test} open={open} onHide={onHide} />
      <button type="button" className="ade-sponsored-title ade-sponsored-open" onClick={open}>
        {ad.title}
      </button>
      <p className="ade-sponsored-text">{ad.text}</p>
    </section>
  );
}
