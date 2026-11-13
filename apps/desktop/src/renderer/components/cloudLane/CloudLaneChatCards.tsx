import { useState } from "react";
import { ArrowSquareOut, CheckCircle } from "@phosphor-icons/react";
import type { AdeCardPayload } from "../../../shared/adeCard";
import { cloudJoinApprovalOfCard, cloudTierRequestOfCard, type CloudLaneJobSnapshot } from "../../../shared/cloudLaneLife";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { CloudMark } from "../remoteTargets/cloudBrand";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { useAdeCloudLaneForBinding } from "../../state/adeCloudLaneIndex";
import { CHAT_CARD_WIDTH_CLASS } from "../chat/chatCardPrimitives";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { cn } from "../ui/cn";
import { CloudLaneJobCard } from "./CloudLaneJobCard";
import { CloudLaneWithoutComputerNotice } from "./CloudLaneWithoutComputer";
import { CloudTierChangeCard } from "./CloudTierChangeCard";
import { tierChangeComputerOf } from "./cloudTierChangeFacts";
import {
  cloudLaneJobFor,
  cloudLaneWithoutComputerForBinding,
  useCloudLaneJobs,
  useCloudLanesWithoutComputer,
} from "./cloudLaneStores";
import { cloudLaneLifeAvailable } from "./cloudLaneActions";

/**
 * The ADE Cloud lane cards a chat shows:
 *
 * - `CloudTierRequestCard`: an agent's `ade cloud resize --request` card in
 *   the transcript, drawn as the tier-change card; once the person says yes
 *   it shows the change's steps in its place.
 * - `CloudJoinApprovalCard`: a lane launch's new computer waits for the
 *   person to approve it joining the account (no desktop window could):
 *   Approve opens the account service's own approval page in ADE's browser,
 *   where the person is signed in and confirms the computer by name.
 * - `CloudLaneChatStatus`: above the prompt box of a chat on a cloud lane,
 *   the lane's size change or move: its start, its steps, its finish ("Moved
 *   to a Large computer · your chat follows") or its failure with the reason
 *   and an ×; or "this lane has no computer now" with "New computer on the
 *   same branch".
 */

const DISMISSED_KEY = "ade.cloudTierRequestsDismissed.v1";

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberDismissed(requestId: string): void {
  try {
    const next = [...readDismissed(), requestId].slice(-100);
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Only this window forgets it; the card can show again after a reload.
  }
}

/** The job a confirmed request started: same chat, same computer, started after the card. */
function jobOfRequest(
  jobs: ReadonlyMap<string, CloudLaneJobSnapshot>,
  input: { chatSessionId: string; instanceId: string; since: string | null },
): CloudLaneJobSnapshot | null {
  let best: CloudLaneJobSnapshot | null = null;
  for (const job of jobs.values()) {
    if (job.requestedByChat !== input.chatSessionId) continue;
    if (job.fromInstanceId !== input.instanceId && job.instanceId !== input.instanceId) continue;
    if (input.since && job.startedAt < input.since) continue;
    if (!best || job.startedAt > best.startedAt) best = job;
  }
  return best;
}

export function CloudTierRequestCard({ card, sessionId }: { card: AdeCardPayload; sessionId: string | null }) {
  const request = sessionId ? cloudTierRequestOfCard(card, sessionId) : null;
  const jobs = useCloudLaneJobs();
  const [dismissed, setDismissed] = useState(() => (request ? readDismissed().has(request.requestId) : false));
  const [started, setStarted] = useState<CloudLaneJobSnapshot | null>(null);
  const job = request
    ? (started ? jobs.get(started.jobId) ?? started : jobOfRequest(jobs, { chatSessionId: request.chatSessionId, instanceId: request.instanceId, since: card.createdAt ?? null }))
    : null;
  // The account (sizes, rates, hours) only while the card still asks.
  const machines = useCloudMachines(Boolean(request) && !dismissed);
  const account = machines.result?.state === "ok" ? machines.result.account : null;
  const box = request && machines.result?.state === "ok"
    ? machines.result.machines.find((entry) => entry.instanceId === request.instanceId) ?? null
    : null;
  const computer = box ? tierChangeComputerOf(box) : null;

  if (!request) {
    return <p className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-muted px-3.5 py-2.5")}>{card.fallbackText}</p>;
  }
  if (job) return <CloudLaneJobCard job={job} account={account} />;
  if (dismissed) {
    return (
      <p className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-answered")}>
        The agent asked to change {request.computerName}&apos;s size. You kept it as it is.
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
        requestId={request.requestId}
        requestedByChat={request.chatSessionId}
        onStarted={setStarted}
        onNotNow={() => {
          rememberDismissed(request.requestId);
          setDismissed(true);
        }}
      />
    </div>
  );
}

export function CloudJoinApprovalCard({ card }: { card: AdeCardPayload }) {
  const approval = cloudJoinApprovalOfCard(card);
  if (!approval) {
    return <p className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-muted px-3.5 py-2.5")}>{card.fallbackText}</p>;
  }
  if (approval.state !== "waiting") {
    return (
      <p className={cn(CHAT_CARD_WIDTH_CLASS, "adecl-answered")} data-cloud-join-approval={approval.state}>
        {approval.state === "joined" ? <CheckCircle size={12} weight="fill" className="adecl-join-done" aria-hidden /> : null}
        {card.title}
      </p>
    );
  }
  return (
    <div className={CHAT_CARD_WIDTH_CLASS}>
      <div className="adecl-nocomp adecl-join" role="status" data-cloud-join-approval="waiting">
        <span className="adecl-nocomp-mark" aria-hidden><CloudMark size={16} brand /></span>
        <div className="adecl-nocomp-text">
          <span className="adecl-join-title">{card.title}</span>
          <span className="adecl-muted">{card.subtitle ?? "The lane waits up to 10 minutes."} You confirm it on ADE&apos;s sign-in page; your phone works too.</span>
        </div>
        <div className="adecl-nocomp-actions">
          <button
            type="button"
            className="kit-btn adecl-btn-sky"
            data-size="xs"
            // The approval is the account's, not a machine's: this computer's ADE browser, where the person is signed in.
            onClick={() => openUrlInAdeBrowser(approval.url)}
          >
            Approve
            <ArrowSquareOut size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Above the prompt box of a chat on an ADE Cloud lane. Nothing for any other
 * chat, and nothing while the lane's computer is simply there. The binding
 * is the chat's own (`pin` of its runtime scope), so the lane is the chat's.
 */
export function CloudLaneChatStatus({
  binding,
  laneId = null,
}: {
  binding: OpenProjectBinding | null;
  /**
   * The chat's own lane id. A cloud lane keeps it when its computer changes,
   * so the card still finds the lane's job while the chat's pin names the old
   * computer (mid-move, or right after one) or a computer this desktop never
   * reached.
   */
  laneId?: string | null;
}) {
  const lane = useAdeCloudLaneForBinding(binding);
  const remote = binding?.kind === "remote";
  const jobs = useCloudLaneJobs(lane != null || (remote && laneId != null));
  const withoutState = useCloudLanesWithoutComputer(remote && cloudLaneLifeAvailable());
  const job = lane
    ? cloudLaneJobFor(jobs, { instanceId: lane.instanceId, laneId: lane.laneId })
    : remote && laneId ? cloudLaneJobFor(jobs, { laneId }) : null;
  const without = !lane && remote ? cloudLaneWithoutComputerForBinding(binding, withoutState.lanes) : null;
  // A job's rates or the former size need the account; read only while a card shows.
  const machines = useCloudMachines(Boolean(job || without));
  const account = machines.result?.state === "ok" ? machines.result.account : null;
  if (job) return <CloudLaneJobCard job={job} account={account} />;
  if (without) return <CloudLaneWithoutComputerNotice lane={without} account={account} />;
  return null;
}
