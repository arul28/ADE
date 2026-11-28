import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { CaretDown, X } from "@phosphor-icons/react";
import type { AdeCardPayload } from "../../../shared/adeCard";
import type { CloudAccountState } from "../../../shared/adeCloud";
import type { CloudLaneJobSnapshot } from "../../../shared/cloudLaneLife";
import {
  CLOUD_TIER_REQUEST_CARD_VARIANT,
  cloudTierRequestAnswerOfCard,
  cloudTierRequestOfCard,
  type CloudTierRequest,
  type CloudTierRequestAnswer,
} from "../../../shared/cloudTierRequest";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { ipcErrorMessage } from "../../lib/format";
import { useStableIdentity } from "../../lib/stableIdentity";
import { CHAT_CARD_WIDTH_CLASS } from "../chat/chatCardPrimitives";
import { useChatRuntimeScope } from "../chat/ChatRuntimeScope";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { CloudLaneJobBar, CloudLaneJobCard } from "./CloudLaneJobCard";
import { CloudTierChangeCard } from "./CloudTierChangeCard";
import { tierChangeComputerOf } from "./cloudTierChangeFacts";
import { answerCloudTierRequest, cloudTierRequestAnswersAvailable } from "./cloudLaneActions";
import { useCloudLaneJobs } from "./cloudLaneStores";
import "./cloudLane.css";
import { BRAND } from "../../../shared/brand";

/**
 * The ADE Cloud lane cards a chat shows:
 *
 * - `CloudTierRequestsAboveComposer`: an agent's `ade cloud resize --request`
 *   that still waits for the person, pinned above the prompt box (where an
 *   "ADE asks" question or a secret request shows), with an × that keeps the
 *   size. The newest open one is pinned; its transcript card turns to one
 *   line that points there.
 * - `CloudTierRequestCard`: the request in the transcript. Unanswered and not
 *   pinned (an older one, or a transcript with no prompt box), the full card;
 *   answered, one line with the answer; once the person says yes, the
 *   change's steps in its place.
 * - The person's answer goes to the chat's OWN machine by the chat's pin
 *   (`cloud.tier_request_answer`): the card is marked answered there for every
 *   surface, and the agent is told in ADE's words. How a change the person
 *   said yes to ended goes there from whatever runs the change (this app's
 *   main process, ADE Web's tab), given the chat's pin at the yes: never
 *   from a window that happens to show the chat.
 * - `CloudLaneChatStatus`: above the prompt box of a chat on a cloud lane,
 *   the lane's size change or move as one slim bar (`CloudLaneJobBar`),
 *   opening to its steps; gone shortly after it finishes. A lane
 *   whose computer was deleted says so in the chat's banner stack instead
 *   (`CloudLaneComputerDeletedBanner`).
 */

// ---------------------------------------------------------------------------
// Requests this window closed, and which request is pinned above the box
// ---------------------------------------------------------------------------

const DISMISSED_KEY = "ade.cloudTierRequestsDismissed.v1";

function readSavedDismissed(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Requests closed in this window: hidden at once. The answer itself lives on
 * the card (its machine marks it), so this only covers the moment before that
 * lands, and a machine too old to take the answer. Read from this computer's
 * copy once, on first use.
 */
let dismissedRequests: ReadonlySet<string> | null = null;
const dismissedListeners = new Set<() => void>();

function dismissedNow(): ReadonlySet<string> {
  dismissedRequests ??= readSavedDismissed();
  return dismissedRequests;
}

function rememberDismissed(requestId: string): void {
  const next = [...dismissedNow(), requestId].slice(-100);
  dismissedRequests = new Set(next);
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Only this window forgets it; the card can show again after a reload.
  }
  for (const listener of dismissedListeners) listener();
}

function subscribeDismissed(listener: () => void): () => void {
  dismissedListeners.add(listener);
  return () => {
    dismissedListeners.delete(listener);
  };
}

const NO_DISMISSED: ReadonlySet<string> = new Set();

function useDismissedRequests(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeDismissed, dismissedNow, () => NO_DISMISSED);
}

/** The request pinned above the prompt box now: its transcript card says so in one line. */
const pinnedRequests = new Set<string>();
const pinnedListeners = new Set<() => void>();

function setPinned(requestId: string, pinned: boolean): void {
  if (pinned === pinnedRequests.has(requestId)) return;
  if (pinned) pinnedRequests.add(requestId);
  else pinnedRequests.delete(requestId);
  for (const listener of pinnedListeners) listener();
}

function subscribePinned(listener: () => void): () => void {
  pinnedListeners.add(listener);
  return () => {
    pinnedListeners.delete(listener);
  };
}

function useRequestPinned(requestId: string | null): boolean {
  return useSyncExternalStore(subscribePinned, () => (requestId ? pinnedRequests.has(requestId) : false), () => false);
}

/** An unanswered request older than this is history, not a question: it is not pinned. */
const PIN_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// The chat's tier request cards
// ---------------------------------------------------------------------------

/** Each tier request card of a transcript once, with its later emits (the answer) merged in. */
export function cloudTierRequestCardsOf(events: readonly AgentChatEventEnvelope[]): AdeCardPayload[] {
  let byId: Map<string, AdeCardPayload> | null = null;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type !== "ade_card" || event.variant !== CLOUD_TIER_REQUEST_CARD_VARIANT) continue;
    byId ??= new Map();
    const previous = byId.get(event.cardId);
    // A repeat emit with the same id is the same card, answered.
    byId.set(event.cardId, previous ? { ...previous, ...event, createdAt: previous.createdAt ?? event.createdAt } : event);
  }
  return byId ? [...byId.values()] : NO_CARDS;
}

const NO_CARDS: AdeCardPayload[] = [];

function cardsFingerprint(cards: readonly AdeCardPayload[]): string {
  return cards.map((card) => `${card.cardId}|${card.updatedAt ?? card.createdAt ?? ""}|${card.state}|${card.rows?.length ?? 0}`).join("\n");
}

const sameCards = (previous: readonly AdeCardPayload[], next: readonly AdeCardPayload[]) => cardsFingerprint(previous) === cardsFingerprint(next);

/**
 * The chat's tier request cards, the same array while they don't change: a
 * streaming turn rewrites the events many times a second, and the box above
 * the composer re-renders only when a request card changes. The scan is one
 * pass over the events for one type and variant.
 */
export function useCloudTierRequestCards(events: readonly AgentChatEventEnvelope[]): readonly AdeCardPayload[] {
  const cards = useMemo(() => cloudTierRequestCardsOf(events), [events]);
  return useStableIdentity<readonly AdeCardPayload[]>(cards, sameCards);
}

/**
 * The job a confirmed request started, the newest when there are several (a
 * Retry on ADE Web is a new job of the same request; the old, closed failure
 * stays in the store). A job that names its request matches only that card,
 * so an older request never claims a later change (a failed Large request
 * and a Medium one asked after it). An older record without the id falls
 * back to same chat, same computer, started after the card. `started`, the
 * change this card started, stands unless a newer job names the request.
 */
function jobOfRequest(
  jobs: ReadonlyMap<string, CloudLaneJobSnapshot>,
  input: { requestId: string; chatSessionId: string; instanceId: string; since: string | null },
  started: CloudLaneJobSnapshot | null = null,
): CloudLaneJobSnapshot | null {
  let named: CloudLaneJobSnapshot | null = started;
  let best: CloudLaneJobSnapshot | null = null;
  for (const job of jobs.values()) {
    if (job.requestId) {
      if (job.requestId === input.requestId && (!named || job.startedAt > named.startedAt)) named = job;
      continue;
    }
    if (job.requestedByChat !== input.chatSessionId) continue;
    if (job.fromInstanceId !== input.instanceId && job.instanceId !== input.instanceId) continue;
    if (input.since && job.startedAt < input.since) continue;
    if (!best || job.startedAt > best.startedAt) best = job;
  }
  return named ?? best;
}

// ---------------------------------------------------------------------------
// Answers, to the chat's own machine
// ---------------------------------------------------------------------------

/**
 * The person's answers to one request: the yes (after its change started) and
 * Keep the size. A closed request leaves through the dismissed store.
 */
function useTierRequestAnswer(input: {
  request: CloudTierRequest | null;
  binding: OpenProjectBinding | null;
}) {
  const { request, binding } = input;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (answer: CloudTierRequestAnswer) => {
    if (!request) return;
    if (!binding) throw new Error(`${BRAND.NAME} doesn't know which computer this chat is on.`);
    await answerCloudTierRequest(binding, { chatSessionId: request.chatSessionId, requestId: request.requestId, answer });
  };
  /** Keep the size: the agent is told, then the card closes here. */
  const dismiss = async () => {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      // A window that can't send it (an older desktop) keeps the size here only, as before.
      if (cloudTierRequestAnswersAvailable()) await send("dismiss");
      rememberDismissed(request.requestId);
    } catch (dismissError) {
      setError(`${BRAND.NAME} couldn't tell the agent: ${ipcErrorMessage(dismissError) || "its computer didn't answer"}.`);
    } finally {
      setBusy(false);
    }
  };
  /** Closes it here without telling the agent, after a failed answer. */
  const hideAnyway = () => {
    if (!request) return;
    rememberDismissed(request.requestId);
    setError(null);
  };
  /** The change started: the card says so for every surface; the agent hears when it ends from what runs it. */
  const started = (job: CloudLaneJobSnapshot) => {
    if (!cloudTierRequestAnswersAvailable()) return;
    void send(job.timing).catch((startError: unknown) => {
      console.warn("[cloud] marking the size request answered failed", ipcErrorMessage(startError));
    });
  };
  /** What the change card needs so the chat hears how the change ended. */
  const changeRequest = request ? { requestId: request.requestId, chatSessionId: request.chatSessionId, chatPin: binding } : null;
  return { busy, error, dismiss, hideAnyway, started, changeRequest, clearError: () => setError(null) };
}

function AnswerError({ error, onHide, onClose }: { error: string; onHide: () => void; onClose: () => void }) {
  return (
    <Banner
      layout="inline"
      style={{ marginTop: 6 }}
      model={{
        id: "cloud-tier-request-answer-error",
        tone: "error",
        title: error,
        detail: "Try again, or hide the card without telling the agent.",
        actions: [{ label: "Hide it anyway", onClick: onHide }],
        report: { surface: "cloud_tier_request_answer" },
        dismiss: { onDismiss: onClose },
      }}
    />
  );
}

/** The account (sizes, rates, credits) and the computer's disk, read only while a card still asks. */
function useRequestFacts(request: CloudTierRequest | null, enabled: boolean): { account: CloudAccountState | null; computer: ReturnType<typeof tierChangeComputerOf> | null } {
  const machines = useCloudMachines(enabled);
  const account = machines.result?.state === "ok" ? machines.result.account : null;
  const box = request && machines.result?.state === "ok"
    ? machines.result.machines.find((entry) => entry.instanceId === request.instanceId) ?? null
    : null;
  return { account, computer: box ? tierChangeComputerOf(box) : null };
}

// ---------------------------------------------------------------------------
// In the transcript
// ---------------------------------------------------------------------------

export function CloudTierRequestCard({ card, sessionId }: { card: AdeCardPayload; sessionId: string | null }) {
  // The chat's own machine, never the tab's: the answer goes where the chat lives.
  const binding = useChatRuntimeScope().binding ?? null;
  const request = sessionId ? cloudTierRequestOfCard(card, sessionId) : null;
  const answered = cloudTierRequestAnswerOfCard(card);
  const pinned = useRequestPinned(request?.requestId ?? null);
  const jobs = useCloudLaneJobs();
  const dismissedHere = useDismissedRequests();
  const dismissed = request ? dismissedHere.has(request.requestId) : false;
  const [started, setStarted] = useState<CloudLaneJobSnapshot | null>(null);
  // The change this card started (as the store has it now), unless a newer job of the same request replaced it (a Retry on ADE Web).
  const job = request
    ? jobOfRequest(
      jobs,
      { requestId: request.requestId, chatSessionId: request.chatSessionId, instanceId: request.instanceId, since: card.createdAt ?? null },
      started ? jobs.get(started.jobId) ?? started : null,
    )
    : null;
  const asking = Boolean(request) && !answered && !dismissed && !job;
  const { account, computer } = useRequestFacts(request, asking && !pinned);
  const answer = useTierRequestAnswer({ request, binding });

  if (!request) {
    return <p className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-muted px-3.5 py-2.5")}>{card.fallbackText}</p>;
  }
  if (job) return <CloudLaneJobCard job={job} account={account} />;
  if (answered?.answer === "dismiss" || (dismissed && !answered)) {
    return (
      <p className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-answered")}>
        The agent asked to change {request.computerName}&apos;s size. You kept it as it is.
      </p>
    );
  }
  if (answered) {
    return (
      <p className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-answered")}>
        The agent asked to change {request.computerName} to {request.toLabel}. {card.subtitle}
      </p>
    );
  }
  if (pinned) {
    return (
      <p className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-answered")} data-cloud-tier-request={request.requestId}>
        The agent asks to change {request.computerName} to {request.toLabel}. Answer it above the prompt box.
      </p>
    );
  }
  return (
    <div className={CHAT_CARD_WIDTH_CLASS} data-cloud-tier-request={request.requestId}>
      <CloudTierChangeCard
        className="adecl-tier-card"
        facts={{
          laneName: request.computerName,
          instanceId: request.instanceId,
          fromSizeId: request.fromSizeId,
          toSizeId: request.toSizeId,
          reason: request.reason || null,
        }}
        account={account}
        computer={computer}
        pickable={false}
        request={answer.changeRequest}
        onStarted={(next) => {
          setStarted(next);
          answer.started(next);
        }}
        notNowLabel="Keep the size"
        notNowBusy={answer.busy}
        onNotNow={() => void answer.dismiss()}
      />
      {answer.error ? <AnswerError error={answer.error} onHide={answer.hideAnyway} onClose={answer.clearError} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Above the prompt box: the open request
// ---------------------------------------------------------------------------

/**
 * Above the prompt box of the chat: its newest tier request that still waits
 * for the person, pinned there. The answer goes to the chat's own machine
 * (`useChatRuntimeScope().binding`).
 */
export function CloudTierRequestsAboveComposer({ cards, sessionId }: { cards: readonly AdeCardPayload[]; sessionId: string }) {
  const binding = useChatRuntimeScope().binding ?? null;
  const jobs = useCloudLaneJobs(cards.length > 0);
  const dismissed = useDismissedRequests();
  const open = useMemo(() => {
    if (cards.length === 0) return null;
    const now = Date.now();
    for (let index = cards.length - 1; index >= 0; index -= 1) {
      const card = cards[index]!;
      if (cloudTierRequestAnswerOfCard(card)) continue;
      const request = cloudTierRequestOfCard(card, sessionId);
      if (!request || dismissed.has(request.requestId)) continue;
      const createdAt = card.createdAt ? Date.parse(card.createdAt) : Number.NaN;
      if (Number.isFinite(createdAt) && now - createdAt > PIN_REQUEST_MAX_AGE_MS) continue;
      if (jobOfRequest(jobs, { requestId: request.requestId, chatSessionId: sessionId, instanceId: request.instanceId, since: card.createdAt ?? null })) continue;
      return { card, request };
    }
    return null;
  }, [cards, dismissed, jobs, sessionId]);
  const openId = open?.request.requestId ?? null;
  useEffect(() => {
    if (!openId) return;
    setPinned(openId, true);
    return () => setPinned(openId, false);
  }, [openId]);
  if (!open) return null;
  return <PinnedTierRequest key={open.request.requestId} card={open.card} request={open.request} binding={binding} />;
}

function PinnedTierRequest({
  card,
  request,
  binding,
}: {
  card: AdeCardPayload;
  request: CloudTierRequest;
  binding: OpenProjectBinding | null;
}) {
  const [folded, setFolded] = useState(false);
  const bodyId = `adecl-tier-pinned-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const { account, computer } = useRequestFacts(request, !folded);
  // Closed by the dismissed store: the box above reads it again and lets this go.
  const answer = useTierRequestAnswer({ request, binding });
  return (
    <div className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-tier-pinned")} data-cloud-tier-request-pinned={request.requestId} role="group" aria-label="The agent asks for a new size">
      <div className="adecl-tier-pinned-head">
        <span className="adecl-tier-mark" aria-hidden><CloudMark size={13} bold /></span>
        <span className="adecl-tier-pinned-title">
          <b>{card.title || `Change ${request.computerName} to ${request.toLabel}?`}</b>
          {folded && request.reason ? <span className="adecl-tier-pinned-reason">{request.reason}</span> : null}
        </span>
        <span className="adecl-tier-pinned-who">The agent asks</span>
        <button
          type="button"
          className="adecl-job-fold"
          aria-expanded={!folded}
          aria-controls={bodyId}
          aria-label={folded ? "Show the request" : "Fold the request"}
          title={folded ? "Show the request" : "Fold it to one line; it stays here until you answer"}
          onClick={() => setFolded((value) => !value)}
        >
          <CaretDown size={11} weight="bold" aria-hidden data-open={folded ? "0" : "1"} />
        </button>
        <button
          type="button"
          className="adecl-job-dismiss"
          aria-label={`Keep ${request.computerName} at its size`}
          title={`Keep the size (${BRAND.NAME} tells the agent)`}
          disabled={answer.busy}
          onClick={() => void answer.dismiss()}
        >
          <X size={10} weight="bold" aria-hidden />
        </button>
      </div>
      {folded ? null : (
        <div id={bodyId} className="adecl-tier-pinned-body">
          <CloudTierChangeCard
            facts={{
              laneName: request.computerName,
              instanceId: request.instanceId,
              fromSizeId: request.fromSizeId,
              toSizeId: request.toSizeId,
              reason: request.reason || null,
            }}
            account={account}
            computer={computer}
            pickable={false}
            headless
            request={answer.changeRequest}
            onStarted={(job) => answer.started(job)}
            notNowLabel="Keep the size"
            notNowBusy={answer.busy}
            onNotNow={() => void answer.dismiss()}
          />
        </div>
      )}
      {answer.error ? <AnswerError error={answer.error} onHide={answer.hideAnyway} onClose={answer.clearError} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Above the prompt box: the lane's size change or move, as a slim bar
// ---------------------------------------------------------------------------

/**
 * Above the prompt box of a chat on an ADE Cloud lane. Nothing for any other
 * chat, and nothing while the lane's computer is simply there. `job` is the
 * chat's own lane job (`useChatCloudLaneJob` with the chat's binding and lane
 * id), the one its Send reads too.
 */
export function CloudLaneChatStatus({ job }: { job: CloudLaneJobSnapshot | null }) {
  // A job's rates need the account; read only while its bar shows.
  const machines = useCloudMachines(Boolean(job));
  const account = machines.result?.state === "ok" ? machines.result.account : null;
  if (!job) return null;
  return <CloudLaneJobBar key={job.jobId} job={job} account={account} className={CHAT_CARD_WIDTH_CLASS} />;
}
