import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TreeStructure } from "@phosphor-icons/react";
import type {
  ComputerUseOwnerSnapshot,
  OpenProjectBinding,
  PendingInputRequest,
  TerminalSessionSummary,
} from "../../../shared/types";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import { PROJECT_SECRET_DELIVERY_QUESTION_ID } from "../../../shared/projectSecretRequest";
import { readNativeInputCard } from "../../../shared/nativeInputCards";
import { useAppStore } from "../../state/appStore";
import { ChatRuntimeScopeProvider } from "../chat/ChatRuntimeScope";
import { ChatSubagentsPanel } from "../chat/ChatSubagentsPanel";
import { ChatComputerUsePanel } from "../chat/ChatComputerUsePanel";
import { ChatActionsDrawerPanel } from "../chat/ChatActionsDrawerPanel";
import { AskQuestionComposer } from "../chat/AskQuestionComposer";
import {
  ProjectSecretRequestComposer,
  projectSecretKeepAnswers,
  projectSecretSaveAnswers,
} from "../chat/ProjectSecretCard";
import { IntegrationConnectComposer } from "../chat/IntegrationConnectCard";
import { McpServerRequestComposer } from "../chat/McpServerCard";
import { MachineRemovalComposer } from "../chat/MachineRemovalCard";
import { useChatMachineSessions, useCliParentChildRows } from "../chat/chatSubagentRoster";
import type { ChatSubagentSnapshot } from "../chat/chatExecutionSummary";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "../work/WorkHeaderPaneToggles";
import { cn } from "../ui/cn";
import { NO_CHAT_MACHINE_MESSAGE, requireChatPin } from "../chat/chatMachinePin";
import { Banner } from "../ui/notice/Banner";

/**
 * A tracked agent CLI gets a chat's actions pane: the same header button, the
 * same pane floated over the terminal (its agents and its proof), and ADE's
 * cards (`ade secrets request`, `ade mcp servers add`, an ask) in the prompt
 * box's place, as a chat's card replaces its composer.
 *
 * Every read and answer goes to the CLI's own machine (`runtimePin`; null is
 * the tab's machine). Cards are re-read when the session row changes (a card
 * raises the row's hand and lowers it when it closes); proof follows the
 * proof events for this session; the child list is the store's session list.
 * Nothing polls.
 */

type CliActionsState = {
  sessionId: string;
  provider: string | null;
  runtimePin: OpenProjectBinding | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  childRows: ChatSubagentSnapshot[];
  runningChildren: number;
  stopChild: (childSessionId: string) => void;
  proof: ComputerUseOwnerSnapshot | null;
  proofCount: number;
  readProof: () => void;
  cards: PendingInputRequest[];
  respondingIds: ReadonlySet<string>;
  answer: (
    request: PendingInputRequest,
    decision: "accept" | "decline",
    answers?: Record<string, string | string[]>,
  ) => Promise<void>;
  /** A read or an action that failed, with a retry for a read. */
  problem: CliActionsProblem | null;
  clearProblem: () => void;
};

type CliActionsProblem = { key: "cards" | "proof" | "action"; title: string; message: string; retry?: () => void };

const CliActionsContext = createContext<CliActionsState | null>(null);

const OPEN_KEY_PREFIX = "ade.work.cliActionsOpen.";
const AUTO_OPENED_KEY_PREFIX = "ade.work.cliActionsAutoOpened.";

function readFlag(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? null : raw === "1";
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage unavailable: the choice just is not kept.
  }
}

/**
 * Wraps a CLI surface. For a tracked agent CLI it provides the actions state
 * to the header button, the side pane and the card dock; for anything else it
 * renders its children as they are.
 */
export function CliActionsScope({
  session,
  runtimePin,
  enabled,
  children,
}: {
  session: TerminalSessionSummary;
  runtimePin: OpenProjectBinding | null;
  enabled: boolean;
  children: ReactNode;
}) {
  const boundBinding = useAppStore((state) => state.projectBinding);
  if (!enabled) return <>{children}</>;
  return (
    <ChatRuntimeScopeProvider
      pin={runtimePin}
      binding={runtimePin ?? boundBinding ?? null}
      laneId={session.laneId ?? null}
      sessionId={session.id}
    >
      <CliActionsStateProvider session={session} runtimePin={runtimePin}>
        {children}
      </CliActionsStateProvider>
    </ChatRuntimeScopeProvider>
  );
}

/** A card's id: `itemId` where the host set one, else the request id. */
function cardId(request: PendingInputRequest): string {
  return request.itemId ?? request.requestId;
}

/** ADE's own cards only: the CLI's permission prompt is answered in its terminal. */
function isAdeCard(request: PendingInputRequest): boolean {
  return request.questions.length > 0;
}

function CliActionsStateProvider({
  session,
  runtimePin,
  children,
}: {
  session: TerminalSessionSummary;
  runtimePin: OpenProjectBinding | null;
  children: ReactNode;
}) {
  const sessionId = session.id;
  const pinKey = runtimePin?.key ?? null;
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const [problem, setProblem] = useState<CliActionsProblem | null>(null);
  const clearProblem = useCallback(() => setProblem(null), []);
  // A read that works again clears its own failure, never another's.
  const settleRead = useCallback((key: CliActionsProblem["key"]) => {
    setProblem((current) => (current?.key === key ? null : current));
  }, []);

  // ── Open state: kept per session, like a chat's ──────────────────────
  const [open, setOpenState] = useState(() => readFlag(`${OPEN_KEY_PREFIX}${sessionId}`) === true);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    writeFlag(`${OPEN_KEY_PREFIX}${sessionId}`, next);
  }, [sessionId]);

  // ── Cards ─────────────────────────────────────────────────────────────
  const [cards, setCards] = useState<PendingInputRequest[]>([]);
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<string>>(() => new Set());
  const cardReadSeq = useRef(0);
  const readCards = useCallback(() => {
    const seq = ++cardReadSeq.current;
    void window.ade.agentChat.listPendingInputs({ sessionId }, pinRef.current)
      .then((result) => {
        if (seq !== cardReadSeq.current) return;
        setCards((result?.requests ?? []).filter(isAdeCard));
        settleRead("cards");
      })
      .catch((readError: unknown) => {
        if (seq !== cardReadSeq.current) return;
        // Keep the cards already shown: an answer still reaches the CLI.
        setProblem({
          key: "cards",
          title: "Couldn't check this CLI for cards waiting on you.",
          message: readError instanceof Error ? readError.message : String(readError),
          retry: () => readCardsRef.current(),
        });
      });
  }, [sessionId, settleRead]);
  const readCardsRef = useRef(readCards);
  readCardsRef.current = readCards;
  // A card raises the row's hand and lowers it when it closes; those row
  // fields are the change signal. Keyed on the pin's key, not the pin object.
  useEffect(() => {
    if (session.status !== "running") {
      setCards([]);
      return;
    }
    readCards();
  }, [readCards, pinKey, session.status, session.attentionRequestedAt, session.attentionSource]);

  const answer = useCallback(async (
    request: PendingInputRequest,
    decision: "accept" | "decline",
    answers?: Record<string, string | string[]>,
  ) => {
    const itemId = cardId(request);
    setRespondingIds((current) => new Set(current).add(itemId));
    setProblem((current) => (current?.key === "action" ? null : current));
    try {
      await window.ade.agentChat.respondToInput({
        sessionId,
        itemId,
        decision,
        ...(answers ? { answers } : {}),
      }, requireChatPin(pinRef.current));
      setCards((current) => current.filter((card) => cardId(card) !== itemId));
    } catch (answerError) {
      setProblem({
        key: "action",
        title: "That answer didn't reach the CLI.",
        message: answerError instanceof Error ? answerError.message : String(answerError),
      });
    } finally {
      setRespondingIds((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
      readCards();
    }
  }, [readCards, sessionId]);

  // ── Children ──────────────────────────────────────────────────────────
  const childRows = useCliParentChildRows(sessionId);
  const machineSessions = useChatMachineSessions();
  const stopChild = useCallback((childSessionId: string) => {
    const child = machineSessions?.find((entry) => entry.id === childSessionId);
    const pin = pinRef.current;
    const stop = !pin
      ? Promise.reject(new Error(NO_CHAT_MACHINE_MESSAGE))
      : child && isChatToolType(child.toolType)
      ? window.ade.agentChat.interrupt({ sessionId: childSessionId }, pin)
      : child?.ptyId
        ? window.ade.pty.dispose({ ptyId: child.ptyId, sessionId: childSessionId }, pin)
        : Promise.reject(new Error("That session is not running here."));
    void stop.catch((stopError: unknown) => {
      setProblem({
        key: "action",
        title: "Couldn't stop that agent.",
        message: stopError instanceof Error ? stopError.message : String(stopError),
      });
    });
  }, [machineSessions]);
  const runningChildren = useMemo(
    () => childRows.filter((row) => row.status === "running").length,
    [childRows],
  );

  // ── Proof ─────────────────────────────────────────────────────────────
  const [proof, setProof] = useState<ComputerUseOwnerSnapshot | null>(null);
  const proofReadSeq = useRef(0);
  const readProof = useCallback(() => {
    const seq = ++proofReadSeq.current;
    const pin = pinRef.current;
    // No machine known: there is nothing to read the proof from.
    if (!pin) return;
    void window.ade.computerUse.getOwnerSnapshot({ owner: { kind: "chat_session", id: sessionId } }, pin)
      .then((snapshot) => {
        if (seq !== proofReadSeq.current) return;
        setProof(snapshot ?? null);
        settleRead("proof");
      })
      .catch((readError: unknown) => {
        if (seq !== proofReadSeq.current) return;
        setProblem({
          key: "proof",
          title: "Couldn't load this CLI's proof.",
          message: readError instanceof Error ? readError.message : String(readError),
          retry: () => readProofRef.current(),
        });
      });
  }, [sessionId, settleRead]);
  const readProofRef = useRef(readProof);
  readProofRef.current = readProof;
  useEffect(() => {
    setProof(null);
    readProof();
    const feedPin = pinRef.current;
    if (!feedPin) return undefined;
    const unsubscribe = window.ade.computerUse.onEvent((event) => {
      const ours = event.owner?.kind === "chat_session" && event.owner.id === sessionId;
      if (ours || (event.type === "artifact-deleted" && event.owner == null)) readProof();
    }, feedPin);
    return unsubscribe;
  }, [readProof, sessionId, pinKey]);
  const proofCount = proof?.artifacts?.length ?? 0;

  // Like a chat's pane: it opens by itself the first time this CLI starts an
  // agent or files proof, once per session; after that it is the user's.
  const hasContent = childRows.length > 0 || proofCount > 0;
  useEffect(() => {
    if (!hasContent) return;
    const key = `${AUTO_OPENED_KEY_PREFIX}${sessionId}`;
    if (readFlag(key)) return;
    writeFlag(key, true);
    setOpen(true);
  }, [hasContent, sessionId, setOpen]);

  const value = useMemo<CliActionsState>(() => ({
    sessionId,
    provider: session.resumeMetadata?.provider ?? null,
    runtimePin,
    open,
    setOpen,
    childRows,
    runningChildren,
    stopChild,
    proof,
    proofCount,
    readProof,
    cards,
    respondingIds,
    answer,
    problem,
    clearProblem,
  }), [
    answer, cards, childRows, clearProblem, problem, open, proof, proofCount, readProof, respondingIds, runningChildren,
    runtimePin, session.resumeMetadata?.provider, sessionId, setOpen, stopChild,
  ]);
  return <CliActionsContext.Provider value={value}>{children}</CliActionsContext.Provider>;
}

/** The chat's actions button, for a CLI header. Same glyph, same badges. */
export function CliActionsToggle() {
  const state = useContext(CliActionsContext);
  if (!state) return null;
  const { open, setOpen, proofCount, runningChildren } = state;
  return (
    <button
      type="button"
      className={cn(WORK_HEADER_ICON_BUTTON_CLASS, "relative")}
      onClick={() => setOpen(!open)}
      title={open ? "Close progress" : "Open progress"}
      aria-label={open ? "Close CLI actions pane" : "Open CLI actions pane"}
      aria-pressed={open}
      data-testid="cli-actions-toggle"
    >
      <TreeStructure size={16} weight="bold" />
      {proofCount > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-emerald-500/80 px-0.5 font-mono text-[8px] font-bold text-black">
          {proofCount}
        </span>
      ) : runningChildren > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-amber-400/85 px-0.5 font-mono text-[8px] font-bold text-(color:--ade-on-tone-ink)">
          {runningChildren}
        </span>
      ) : null}
    </button>
  );
}

const EMPTY_EVENTS: never[] = [];

/**
 * The actions pane, floated over the terminal's top-right corner the way a
 * chat floats it over its transcript: the same card and drawer. Render it
 * inside the terminal's positioned box.
 */
export function CliActionsSidePane() {
  const state = useContext(CliActionsContext);
  if (!state?.open) return null;
  const { sessionId, childRows, stopChild, proof, proofCount, readProof, runtimePin } = state;
  return (
    <div
      className="pointer-events-none absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(16.5rem,calc(100%-1.5rem))] flex-col"
      data-testid="cli-actions-pane"
    >
      <div className="pointer-events-auto flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-fg/[0.07] bg-[color:var(--work-sidebar-bg,#161618)] shadow-[0_20px_60px_-30px_rgba(0,0,0,0.8)]">
        <ChatActionsDrawerPanel
          emptyCopy="Nothing here yet. Agents this CLI starts and proof it files show up here."
          sections={[
            childRows.length > 0 && {
              key: "agents",
              content: (
                <ChatSubagentsPanel
                  sessionId={sessionId}
                  snapshots={childRows}
                  events={EMPTY_EVENTS}
                  variant="pane"
                  onStopSpawnedChild={stopChild}
                />
              ),
            },
            proofCount > 0 && {
              key: "proof",
              priority: true,
              content: (
                <ChatComputerUsePanel
                  snapshot={proof}
                  onRefresh={readProof}
                  allowLocalArtifactProtocol={runtimePin == null}
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

/**
 * The prompt box's place: a card this CLI raised takes it, the way a chat's
 * card replaces its composer, and the box (`children`) comes back when the
 * last card is answered. With no box shown (typing in the terminal), the card
 * sits in the same place under the terminal.
 */
export function CliPromptSlot({ children }: { children?: ReactNode }) {
  const state = useContext(CliActionsContext);
  const problem = state?.problem ?? null;
  const banner = problem ? (
    <div className="shrink-0 px-3 pt-2">
      <div className="mx-auto w-full max-w-[var(--chat-column,46rem)]">
        <Banner
          layout="inline"
          model={{
            id: `cli-actions-${problem.key}`,
            tone: "error",
            title: problem.title,
            error: problem.message,
            ...(problem.retry ? { actions: [{ label: "Try again", onClick: problem.retry }] } : {}),
            dismiss: { onDismiss: state!.clearProblem },
          }}
        />
      </div>
    </div>
  ) : null;
  if (!state || state.cards.length === 0) return <>{banner}{children}</>;
  const { cards, provider, respondingIds, answer } = state;
  return (
    <>
    {banner}
    <div className="shrink-0 bg-[color:var(--chat-canvas-bg)] px-3 pb-3 pt-2" data-testid="cli-cards-dock">
      <div className="mx-auto w-full max-w-[var(--chat-column,46rem)] space-y-2">
        {cards.map((request) => (
          <CliCard
            key={cardId(request)}
            request={request}
            provider={provider}
            responding={respondingIds.has(cardId(request))}
            onAnswer={answer}
          />
        ))}
      </div>
    </div>
    </>
  );
}

function CliCard({
  request,
  provider,
  responding,
  onAnswer,
}: {
  request: PendingInputRequest;
  provider: string | null;
  responding: boolean;
  onAnswer: (
    request: PendingInputRequest,
    decision: "accept" | "decline",
    answers?: Record<string, string | string[]>,
  ) => Promise<void>;
}) {
  const nativeCard = readNativeInputCard(request);
  const decline = () => { void onAnswer(request, "decline"); };
  if (nativeCard?.kind === "secret") {
    const card = nativeCard.card;
    return (
      <ProjectSecretRequestComposer
        request={request}
        card={card}
        responding={responding}
        fileDeliveryAvailable={request.questions.some((question) => question.id === PROJECT_SECRET_DELIVERY_QUESTION_ID)}
        onSave={(value, delivery) => { void onAnswer(request, "accept", projectSecretSaveAnswers(card, value, delivery)); }}
        onKeepExisting={() => { void onAnswer(request, "accept", projectSecretKeepAnswers()); }}
        onDecline={decline}
      />
    );
  }
  if (nativeCard?.kind === "connect") {
    return (
      <IntegrationConnectComposer
        request={request}
        card={nativeCard.card}
        responding={responding}
        error={null}
        chatProvider={provider}
        onConnect={(answers) => { void onAnswer(request, "accept", answers); }}
        onDecline={decline}
      />
    );
  }
  if (nativeCard?.kind === "mcp-server") {
    return (
      <McpServerRequestComposer
        request={request}
        card={nativeCard.card}
        responding={responding}
        error={null}
        chatProvider={provider}
        onAdd={(answers) => { void onAnswer(request, "accept", answers); }}
        onDecline={decline}
      />
    );
  }
  if (nativeCard?.kind === "machine-removal") {
    return (
      <MachineRemovalComposer
        request={request}
        card={nativeCard.card}
        responding={responding}
        error={null}
        chatProvider={provider}
        onAnswer={(answers) => { void onAnswer(request, "accept", answers); }}
      />
    );
  }
  return (
    <AskQuestionComposer
      request={request}
      responding={responding}
      onSubmit={(answers) => { void onAnswer(request, "accept", answers); }}
      onDecline={decline}
    />
  );
}
