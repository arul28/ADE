import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUpRight, X } from "@phosphor-icons/react";
import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { isGravityUrl, type CloudSponsoredAd, type CloudSponsoredAdAnswer, type CloudSponsoredConsent } from "../../../../shared/adeCloud";
import { setCloudSponsoredConsent, useCloudAccount } from "../../../state/cloudAccountStore";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { openExternalUrl } from "../../../lib/openExternal";
import { Button } from "../../ui/Button";
import { holdSponsoredPlace, releaseSponsoredPlace, useOnScreen, useSponsoredPlaceHolder } from "./sponsoredOnScreen";
import { SPONSORED_TURN_FRESH_MS, lastFinishedTurn, sponsoredDevice } from "./sponsoredTurn";
import { useDocumentVisible, useSponsoredViewer } from "./useSponsoredViewer";
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

const ANSWER_CACHE_LIMIT = 50;
const NOT_CLOUD_RETRY_MS = 12_000;

const answers = new Map<string, Promise<CloudSponsoredAdAnswer>>();
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
}: Omit<SponsoredReplySlotProps, "instanceId" | "sessionId"> & {
  instanceId: string;
  sessionId: string;
  consent: CloudSponsoredConsent | null;
  test: boolean;
}) {
  const visible = useDocumentVisible() && paneVisible;
  // The scan runs only between turns; while one streams there is no card.
  const turn = useMemo(() => (turnActive ? null : lastFinishedTurn(events)), [events, turnActive]);
  const fresh = turn != null && Date.now() - turn.finishedAt < SPONSORED_TURN_FRESH_MS;
  const turnKey = turn ? `${sessionId}:${turn.turnId}` : null;
  const [hidden, setHidden] = useState(() => (turnKey ? hiddenTurns.has(turnKey) : false));
  useEffect(() => setHidden(turnKey ? hiddenTurns.has(turnKey) : false), [turnKey]);

  // The place under the reply, card included: a card shows only while it is on screen.
  const regionRef = useRef<HTMLDivElement | null>(null);
  const wanted = fresh && !hidden && visible;
  const onScreen = useOnScreen(regionRef, 0, wanted);

  // Someone is watching this computer's chat: the Index may answer its agents.
  useSponsoredViewer(instanceId, consent === "granted" && visible);

  // One sponsored card on screen in the whole window. A pane whose place
  // another card holds doesn't even ask: its card could never show.
  const slotId = useId();
  const holder = useSponsoredPlaceHolder();
  const placeFree = holder === null || holder === slotId;

  const [ad, setAd] = useState<{ key: string; ad: CloudSponsoredAd } | null>(null);
  // A chat's first reply can be asked about before its computer saved the
  // chat's copy (`not_cloud`): one more ask a little later, never more.
  const [askAgain, setAskAgain] = useState<string | null>(null);
  useEffect(() => {
    if (consent !== "granted" || !wanted || !onScreen || !placeFree || !turn || !turnKey) return;
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
  }, [consent, wanted, onScreen, placeFree, turn, turnKey, ad?.key, instanceId, sessionId, askAgain]);

  const adShown = ad !== null && ad.key === turnKey;
  let showing: "consent" | "ad" | null = null;
  if (wanted && onScreen && consent === null) showing = "consent";
  else if (wanted && onScreen && adShown) showing = "ad";

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
    <div ref={regionRef} className="w-full max-w-[var(--chat-content-width,52rem)]">
      <div aria-hidden className="h-px w-full" />
      {holds && showing === "consent" ? <SponsoredConsentCard /> : null}
      {holds && showing === "ad" && ad ? <SponsoredAdCard ad={ad.ad} test={test} onHide={hide} /> : null}
    </div>
  );
}

function SponsoredConsentCard() {
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
      <p className="ade-sponsored-title">Free cloud chats are ad-supported</p>
      <p className="ade-sponsored-text">
        A Free chat on ADE Cloud can show one sponsored card under a finished reply, and an agent may recommend a
        sponsored tool. To pick them, ADE sends Gravity, our ad partner, your last message and the reply (or the
        agent's search), your IP address, your device type and a hashed copy of your account email. Sponsored cards
        are for people 18 or older. You can change this in Settings › ADE Cloud.
      </p>
      <div className="ade-sponsored-actions">
        <Button size="sm" casing="sentence" variant="outline" disabled={busy} onClick={() => answer("granted")}>
          Show sponsored cards
        </Button>
        <Button size="sm" casing="sentence" variant="outline" disabled={busy} onClick={() => answer("declined")}>
          No thanks
        </Button>
        <button type="button" className="ade-sponsored-link" onClick={() => openExternalUrl("https://ade-app.dev/privacy#sponsored")}>
          How it works
        </button>
      </div>
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
