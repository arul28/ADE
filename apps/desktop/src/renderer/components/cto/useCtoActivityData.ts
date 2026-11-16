import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatSessionSummary,
  ComputerUseArtifactView,
  OpenProjectBinding,
  PrSummary,
} from "../../../shared/types";
import { PROOF_LISTING_ARTIFACT_FILTER } from "../../../shared/types/computerUseArtifacts";

/** Chats the CTO started, newest first, with whether each is still going. */
export type CtoChildChat = {
  summary: AgentChatSessionSummary;
  running: boolean;
};

export type CtoActivityData = {
  children: CtoChildChat[];
  /** Library only; empty until the Library has been opened. */
  prs: PrSummary[];
  proof: ComputerUseArtifactView[];
  libraryLoaded: boolean;
  refresh: () => void;
};

/** Events that can change who the CTO's children are, what they are doing, or what they produced. */
const REFRESH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "status",
  "done",
  "subagent_started",
  "system_notice",
  "approval_request",
  "structured_question",
  "pending_input_resolved",
]);

const REFRESH_DEBOUNCE_MS = 800;
const SAFETY_REFRESH_MS = 60_000;
/** Proof is read per chat; the newest children are the ones worth a read. */
const PROOF_CHILD_CAP = 12;
const PROOF_PER_CHAT = 12;

function childIsRunning(summary: AgentChatSessionSummary): boolean {
  if (summary.endedAt || summary.status === "ended") return false;
  return summary.status === "active" || Boolean(summary.currentTurnStartedAt) || summary.awaitingInput === true;
}

/**
 * The panel's data: the CTO's child chats (Activity), and the PRs, proof and
 * lanes they produced (Library).
 *
 * Every read goes to `pin`, the CTO's home machine, where the CTO and the
 * chats it started live. Live updates come from that machine's chat events for
 * the CTO and its children, debounced; the only timer is one safety read a
 * minute while the panel is on screen and the window is visible. The Library's
 * reads (PRs, proof) only run once the Library has been opened.
 */
export function useCtoActivityData({
  ctoSessionId,
  pin,
  visible,
  libraryOpen,
}: {
  ctoSessionId: string | null;
  pin: OpenProjectBinding | null;
  /** The panel is on screen. */
  visible: boolean;
  libraryOpen: boolean;
}): CtoActivityData {
  const pinKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const [children, setChildren] = useState<CtoChildChat[]>([]);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [proof, setProof] = useState<ComputerUseArtifactView[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const childIdsRef = useRef<Set<string>>(new Set());
  const libraryOpenRef = useRef(libraryOpen);
  libraryOpenRef.current = libraryOpen;
  const generationRef = useRef(0);

  // A different CTO (another home, another thread) shows nothing of the last one.
  useEffect(() => {
    generationRef.current += 1;
    childIdsRef.current = new Set();
    setChildren([]);
    setPrs([]);
    setProof([]);
    setLibraryLoaded(false);
  }, [ctoSessionId, pinKey]);

  const load = useCallback(async () => {
    const target = pinRef.current;
    const agentChat = window.ade?.agentChat;
    if (!target || !ctoSessionId || !agentChat?.list) return;
    const generation = generationRef.current;
    let summaries: AgentChatSessionSummary[] = [];
    try {
      summaries = await agentChat.list({ includeArchived: false }, target);
    } catch {
      return;
    }
    if (generation !== generationRef.current) return;
    const mine = summaries
      .filter((summary) => summary.sessionId !== ctoSessionId
        && summary.orchestrationParentSessionId?.trim() === ctoSessionId
        && !summary.archivedAt)
      .sort((left, right) => (left.startedAt < right.startedAt ? 1 : left.startedAt > right.startedAt ? -1 : 0))
      .map((summary) => ({ summary, running: childIsRunning(summary) }));
    childIdsRef.current = new Set(mine.map((child) => child.summary.sessionId));
    setChildren(mine);

    if (!libraryOpenRef.current) return;
    const childLaneIds = new Set(mine.map((child) => child.summary.laneId).filter(Boolean));
    const owners = [ctoSessionId, ...mine.slice(0, PROOF_CHILD_CAP).map((child) => child.summary.sessionId)];
    const [allPrs, proofLists] = await Promise.all([
      window.ade?.prs?.listAll
        ? window.ade.prs.listAll(target).catch(() => [] as PrSummary[])
        : Promise.resolve([] as PrSummary[]),
      Promise.all(owners.map((id) => (window.ade?.computerUse?.listArtifacts
        ? window.ade.computerUse.listArtifacts({
          owner: { kind: "chat_session", id },
          ...PROOF_LISTING_ARTIFACT_FILTER,
          limit: PROOF_PER_CHAT,
        }, target).catch(() => [] as ComputerUseArtifactView[])
        : Promise.resolve([] as ComputerUseArtifactView[])))),
    ]);
    if (generation !== generationRef.current) return;
    setPrs(allPrs.filter((pr) => childLaneIds.has(pr.laneId)));
    const seen = new Set<string>();
    const merged: ComputerUseArtifactView[] = [];
    for (const list of proofLists) {
      for (const artifact of list) {
        if (seen.has(artifact.id)) continue;
        seen.add(artifact.id);
        merged.push(artifact);
      }
    }
    merged.sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0));
    setProof(merged);
    setLibraryLoaded(true);
  }, [ctoSessionId]);

  const loadRef = useRef(load);
  loadRef.current = load;

  // First read, and again whenever the Library is opened for the first time.
  useEffect(() => {
    if (!visible || !ctoSessionId || !pinKey) return;
    void loadRef.current();
  }, [ctoSessionId, libraryOpen, pinKey, visible]);

  // Event-driven refresh: the CTO's own events and its children's, debounced.
  useEffect(() => {
    if (!visible || !ctoSessionId || !pinRef.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void loadRef.current();
      }, REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = window.ade?.agentChat?.onEvent?.((envelope) => {
      if (!REFRESH_EVENT_TYPES.has(envelope.event.type)) return;
      if (envelope.sessionId !== ctoSessionId && !childIdsRef.current.has(envelope.sessionId)) return;
      schedule();
    }, pinRef.current);
    // One safety read a minute while on screen, for what no event announces
    // (a PR opened from a child's terminal, a lane archived elsewhere).
    const safety = setInterval(() => {
      if (document.visibilityState === "visible") void loadRef.current();
    }, SAFETY_REFRESH_MS);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(safety);
      unsubscribe?.();
    };
  }, [ctoSessionId, pinKey, visible]);

  const refresh = useCallback(() => { void loadRef.current(); }, []);
  return useMemo(
    () => ({ children, prs, proof, libraryLoaded, refresh }),
    [children, libraryLoaded, proof, prs, refresh],
  );
}
