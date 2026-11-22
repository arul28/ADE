import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, X } from "@phosphor-icons/react";
import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { isGravityUrl, type CloudSponsoredAd, type CloudSponsoredAdAnswer, type CloudSponsoredConsent } from "../../../../shared/adeCloud";
import { noteCloudSponsoredState, useCloudAccount } from "../../../state/cloudAccountStore";
import { openExternalUrl } from "../../../lib/openExternal";
import { Button } from "../../ui/Button";
import { holdSponsoredPlace, releaseSponsoredPlace, useSponsoredPlaceHolder } from "./sponsoredOnScreen";
import { SPONSORED_TURN_FRESH_MS, lastFinishedTurn, sponsoredDevice } from "./sponsoredTurn";
import "./sponsored.css";

/**
 * One sponsored card under a finished reply, in a Free-plan chat on an ADE
 * Cloud computer only (`docs/plans/pricing-v2-and-gravity.md`).
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

/** How often a visible cloud chat tells the server someone is watching (the Index needs a person there). */
const SEEN_EVERY_MS = 4 * 60_000;
const ANSWER_CACHE_LIMIT = 50;
const NOT_CLOUD_RETRY_MS = 12_000;

const answers = new Map<string, Promise<CloudSponsoredAdAnswer>>();
const lastSeenAt = new Map<string, number>();
const viewedAds = new Set<string>();
const hiddenTurns = new Set<string>();

function askOnce(key: string, ask: () => Promise<CloudSponsoredAdAnswer>): Promise<CloudSponsoredAdAnswer> {
  const known = answers.get(key);
  if (known) return known;
  const pending = ask().catch((): CloudSponsoredAdAnswer => ({ ad: null, reason: "unavailable" }));
  answers.set(key, pending);
  if (answers.size > ANSWER_CACHE_LIMIT) answers.delete(answers.keys().next().value as string);
  return pending;
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => false);
}

/** Whether `ref`'s element has at least `threshold` of itself on screen. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>, threshold: number, active: boolean): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof IntersectionObserver === "undefined") {
      setOnScreen(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOnScreen(entry.isIntersecting && entry.intersectionRatio >= threshold);
      },
      { threshold: [0, threshold] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold, active]);
  return onScreen;
}

export type SponsoredReplySlotProps = {
  /** The ADE Cloud lane computer the chat runs on (`useAdeCloudLaneForBinding` of its pin); null on the person's own machine. */
  instanceId: string | null;
  sessionId: string | null;
  events: readonly AgentChatEventEnvelope[];
  turnActive: boolean;
};

export function SponsoredReplySlot({ instanceId, sessionId, events, turnActive }: SponsoredReplySlotProps) {
  const account = useCloudAccount(Boolean(instanceId && sessionId));
  const sponsored = account?.sponsored;
  if (!instanceId || !sessionId || !sponsored?.ads || sponsored.consent === "declined") return null;
  return (
    <SponsoredReplySlotOn
      instanceId={instanceId}
      sessionId={sessionId}
      events={events}
      turnActive={turnActive}
      consent={sponsored.consent}
      test={sponsored.test}
    />
  );
}

function SponsoredReplySlotOn({
  instanceId,
  sessionId,
  events,
  turnActive,
  consent,
  test,
}: {
  instanceId: string;
  sessionId: string;
  events: readonly AgentChatEventEnvelope[];
  turnActive: boolean;
  consent: CloudSponsoredConsent | null;
  test: boolean;
}) {
  const visible = useDocumentVisible();
  // The scan runs only between turns; while one streams there is no card.
  const turn = useMemo(() => (turnActive ? null : lastFinishedTurn(events)), [events, turnActive]);
  const fresh = turn != null && Date.now() - turn.finishedAt < SPONSORED_TURN_FRESH_MS;
  const turnKey = turn ? `${sessionId}:${turn.turnId}` : null;
  const [hidden, setHidden] = useState(() => (turnKey ? hiddenTurns.has(turnKey) : false));
  useEffect(() => setHidden(turnKey ? hiddenTurns.has(turnKey) : false), [turnKey]);

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const wanted = fresh && !hidden && visible;
  const anchorOnScreen = useOnScreen(anchorRef, 0, wanted);

  // Someone is watching this computer's chat: the Index may answer its agents.
  useEffect(() => {
    if (consent !== "granted" || !visible) return;
    const tell = () => {
      const last = lastSeenAt.get(instanceId) ?? 0;
      if (Date.now() - last < SEEN_EVERY_MS) return;
      lastSeenAt.set(instanceId, Date.now());
      void window.ade?.cloud?.sponsoredSeen?.({ instanceId, device: sponsoredDevice() });
    };
    tell();
    const timer = window.setInterval(tell, SEEN_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [consent, visible, instanceId]);

  const [ad, setAd] = useState<{ key: string; ad: CloudSponsoredAd } | null>(null);
  // A chat's first reply can be asked about before its computer saved the
  // chat's copy (`not_cloud`): one more ask a little later, never more.
  const [askAgain, setAskAgain] = useState<string | null>(null);
  useEffect(() => {
    if (consent !== "granted" || !wanted || !anchorOnScreen || !turn || !turnKey) return;
    if (ad?.key === turnKey) return;
    const askAd = window.ade?.cloud?.sponsoredAd;
    if (!askAd) return;
    let live = true;
    let timer: number | null = null;
    void askOnce(turnKey, () => askAd({ instanceId, chatId: sessionId, turnId: turn.turnId, messages: turn.messages, device: sponsoredDevice() }))
      .then((answer) => {
        if (!live) return;
        if (answer.ad && isGravityUrl(answer.ad.clickUrl)) setAd({ key: turnKey, ad: answer.ad });
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
  }, [consent, wanted, anchorOnScreen, turn, turnKey, ad?.key, instanceId, sessionId, askAgain]);

  const showing: "consent" | "ad" | null = !wanted
    ? null
    : consent === null
      ? "consent"
      : ad && ad.key === turnKey
        ? "ad"
        : null;

  // One sponsored card on screen in the whole window.
  const slotId = `${sessionId}`;
  const holder = useSponsoredPlaceHolder();
  useEffect(() => {
    if (showing) holdSponsoredPlace(slotId);
    else releaseSponsoredPlace(slotId);
  }, [showing, slotId, holder]);
  useEffect(() => () => releaseSponsoredPlace(slotId), [slotId]);
  const holds = holder === slotId;

  const hide = () => {
    if (turnKey) hiddenTurns.add(turnKey);
    setHidden(true);
  };

  return (
    <div className="w-full max-w-[var(--chat-content-width,52rem)]">
      <div ref={anchorRef} aria-hidden className="h-px w-full" />
      {holds && showing === "consent" ? <SponsoredConsentCard /> : null}
      {holds && showing === "ad" && ad ? <SponsoredAdCard ad={ad.ad} test={test} onHide={hide} /> : null}
    </div>
  );
}

function SponsoredConsentCard() {
  const [busy, setBusy] = useState<CloudSponsoredConsent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (consent: CloudSponsoredConsent) => {
    const set = window.ade?.cloud?.setSponsoredConsent;
    if (!set) return;
    setBusy(consent);
    setError(null);
    void set(consent)
      .then((state) => noteCloudSponsoredState(state))
      .catch(() => setError("ADE couldn't save that. Try again."))
      .finally(() => setBusy(null));
  };
  return (
    <section className="ade-sponsored" aria-label="Sponsored cards on ADE Cloud Free">
      <div className="ade-sponsored-head">
        <span className="ade-sponsored-label">ADE Cloud Free</span>
      </div>
      <p className="ade-sponsored-title">Free cloud chats are ad-supported</p>
      <p className="ade-sponsored-text">
        A Free chat on ADE Cloud can show one sponsored card under a finished reply. To pick it, ADE sends your last
        message, the reply, your IP address and your device type to Gravity, our ad partner. Sponsored cards are for
        people 18 or older. You can change this in Settings › ADE Cloud.
      </p>
      <div className="ade-sponsored-actions">
        <Button size="sm" casing="sentence" variant="outline" disabled={busy !== null} onClick={() => answer("granted")}>
          Show sponsored cards
        </Button>
        <Button size="sm" casing="sentence" variant="outline" disabled={busy !== null} onClick={() => answer("declined")}>
          No thanks
        </Button>
        <button type="button" className="ade-sponsored-link" onClick={() => openExternalUrl("https://ade-app.dev/privacy#sponsored")}>
          How it works
        </button>
      </div>
      {error ? <p className="ade-sponsored-error" role="alert">{error}</p> : null}
    </section>
  );
}

function SponsoredAdCard({ ad, test, onHide }: { ad: CloudSponsoredAd; test: boolean; onHide: () => void }) {
  const cardRef = useRef<HTMLElement | null>(null);
  const visible = useDocumentVisible();
  const halfOnScreen = useOnScreen(cardRef, 0.5, true);
  useEffect(() => {
    if (!halfOnScreen || !visible || !ad.impUrl || viewedAds.has(ad.id)) return;
    viewedAds.add(ad.id);
    void window.ade?.cloud?.sponsoredViewed?.(ad.impUrl);
  }, [halfOnScreen, visible, ad.id, ad.impUrl]);
  const open = () => {
    if (isGravityUrl(ad.clickUrl)) openExternalUrl(ad.clickUrl);
  };
  return (
    <section ref={cardRef} className="ade-sponsored" aria-label={`Sponsored: ${ad.brand}`}>
      <div className="ade-sponsored-head">
        <span className="ade-sponsored-mark" aria-hidden>{ad.brand.slice(0, 1).toUpperCase()}</span>
        <span className="ade-sponsored-brand">{ad.brand}</span>
        <span className="ade-sponsored-label">{test || ad.test ? "Sponsored · test" : "Sponsored"}</span>
        <button type="button" className="ade-sponsored-hide" aria-label="Hide this card" title="Hide" onClick={onHide}>
          <X size={12} weight="bold" />
        </button>
      </div>
      <button type="button" className="ade-sponsored-title ade-sponsored-open" onClick={open}>
        {ad.title}
      </button>
      <p className="ade-sponsored-text">{ad.text}</p>
      <div className="ade-sponsored-actions">
        <button type="button" className="ade-sponsored-cta" onClick={open}>
          {ad.cta ?? "Learn more"}
          <ArrowUpRight size={12} weight="bold" aria-hidden />
        </button>
      </div>
    </section>
  );
}
