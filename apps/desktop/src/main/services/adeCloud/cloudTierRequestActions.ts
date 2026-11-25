/**
 * The `cloud` actions for an agent's size request (`ade cloud resize
 * --request`): `tier_request` posts the card in the agent's chat, and
 * `tier_request_answer` takes the person's answer and how the change ended,
 * on the chat's own machine, and tells the agent. The card and the words are
 * `shared/cloudTierRequest.ts`; the change itself runs where the person
 * confirmed it (this app's main process, ADE Web's tab). Part of
 * `buildCloudAgentActions` (`cloudAgentActions.ts`).
 */

import { randomUUID } from "node:crypto";
import { cloudCatalogOf, type CloudMachine, type CloudMachinesResult } from "../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import {
  buildCloudTierRequestAnsweredCard,
  buildCloudTierRequestCard,
  cloudTierRequestAgentMessage,
  cloudTierRequestAnswerOfCard,
  cloudTierRequestCardId,
  cloudTierRequestOfCard,
  cloudTierRequestToldKey,
  cloudTierRequestToldOfCard,
  isCloudTierRequestAnswer,
  isCloudTierRequestOutcome,
  type CloudTierRequestOutcome,
} from "../../../shared/cloudTierRequest";
import { CLOUD_TIER_IDS, cloudTier, cloudTierOfMachine, cloudTierRateLabel, cloudTiers, isCloudTierId } from "../../../shared/cloudTiers";
import { cloudUnitWords } from "../../../shared/cloudUnitWords";
import { getErrorMessage } from "../shared/utils";
import { clipReason, readApproval, record, text } from "./cloudActionArgs";
import type { CloudChatApprovals } from "./cloudAgentActions";
import type { CloudLogger } from "./cloudProvider";

export type CloudTierRequestActionDeps = {
  approvals: CloudChatApprovals | null;
  /** A computer of the account by its ADE Cloud id, machine key or name, with the list it was found in. */
  resolveMachine: (selector: string | null) => Promise<{ box: CloudMachine; all: CloudMachinesResult }>;
  logger: CloudLogger;
};

/**
 * The answers to one request card, one at a time (the actions are rebuilt
 * per call): each reads the card the one before it posted, so two reports of
 * the same end that arrive together tell the agent once. What was told is on
 * the card itself (`cloudTierRequestToldOfCard`), so that holds across
 * restarts too.
 */
const tierAnswerTurns = new Map<string, Promise<unknown>>();

function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (tierAnswerTurns.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  tierAnswerTurns.set(key, next);
  const settled = () => {
    if (tierAnswerTurns.get(key) === next) tierAnswerTurns.delete(key);
  };
  next.then(settled, settled);
  return next;
}

export function buildCloudTierRequestActions(deps: CloudTierRequestActionDeps) {
  const { resolveMachine, logger } = deps;

  const actions = {
    /**
     * An agent asks the person for a tier change (Android on a Small computer
     * needs Large): a card in its chat with the size, the rate and its
     * reason. It changes nothing: the person confirms on the card, and the
     * app's main process runs the change. An agent never changes a tier
     * itself, attended or not.
     */
    async tier_request(rawArgs?: unknown) {
      const args = record(rawArgs);
      const approval = readApproval(args);
      if (approval.by === "person") throw new Error("Change the size directly: Settings › ADE Cloud, or ade cloud resize.");
      const chatSessionId = approval.chatSessionId;
      if (!chatSessionId || !deps.approvals?.postCard) {
        throw new Error("ADE has no chat to show this request in. Ask the person to change the size in Settings › ADE Cloud.");
      }
      const sizeId = text(args, "size")?.toLowerCase() ?? null;
      if (!isCloudTierId(sizeId)) throw new Error(`Pick a size: ${CLOUD_TIER_IDS.join(", ")}.`);
      const reason = text(args, "reason");
      if (!reason) throw new Error("Say why the lane needs it (--reason).");
      // On a cloud computer the agent asks for its own computer by default.
      const selector = text(args, "machine") ?? process.env.ADE_CLOUD_INSTANCE_ID?.trim() ?? null;
      const { box, all } = await resolveMachine(selector);
      const catalog = cloudCatalogOf(all.account);
      const tiers = cloudTiers(catalog);
      const to = cloudTier(catalog, sizeId);
      if (!to) throw new Error("ADE Cloud doesn't offer that size now.");
      const from = cloudTierOfMachine(box, tiers);
      if (from?.id === to.id) throw new Error(`It's already ${to.label}.`);
      const requestId = randomUUID();
      const computerName = (box as CloudLaneMachine).lane?.laneName ?? box.name ?? box.instanceId;
      const card = buildCloudTierRequestCard(
        { requestId, instanceId: box.instanceId, computerName, fromSizeId: from?.id ?? null, toSizeId: to.id, toLabel: to.label, reason: clipReason(reason), chatSessionId },
        { from: from?.label ?? null, rate: cloudTierRateLabel(to, cloudUnitWords(all.account)) },
      );
      await deps.approvals.postCard(chatSessionId, card);
      logger.info?.("cloud.tier_requested", { instanceId: box.instanceId, toSizeId: to.id, fromSizeId: from?.id ?? null });
      return {
        requested: true,
        requestId,
        message: `Asked the person in this chat to change ${computerName} to ${to.label}. Nothing changes until they confirm; keep working or end your turn. ADE tells you in this chat when they keep the size, or once the change is done.`,
      };
    },

    /**
     * The person's answer to a `tier_request` card from their own client, and
     * how the change they said yes to ended from the layer that ran it (this
     * app's main process, ADE Web's tab), on the chat's own machine
     * (user-only: an agent never answers its own card). The card is read from
     * the chat here, never taken from the caller. It is marked answered for
     * every surface (`cardId` merges), and the agent is told in ADE's words
     * (`cloudTierRequestAgentMessage`): a wake when the person keeps the size
     * and when the change ends, a note for its next turn at the yes. The card
     * keeps what the agent was told, so a second report of it tells nothing.
     */
    async tier_request_answer(rawArgs?: unknown) {
      const args = record(rawArgs);
      const chatSessionId = text(args, "chatSessionId");
      if (!chatSessionId) throw new Error("Name the chat the card is in (chatSessionId).");
      const requestId = text(args, "requestId");
      if (!requestId) throw new Error("Name the size request (requestId).");
      const answer = args.answer;
      if (!isCloudTierRequestAnswer(answer)) throw new Error("Answer idle, now or dismiss.");
      const rawOutcome = args.outcome ?? null;
      let outcome: CloudTierRequestOutcome | null = null;
      if (rawOutcome !== null) {
        if (!isCloudTierRequestOutcome(rawOutcome) || answer === "dismiss") throw new Error("A change ends online, failed or cancelled.");
        outcome = rawOutcome;
      }
      const error = text(args, "error")?.slice(0, 300) ?? null;
      const postCard = deps.approvals?.postCard;
      const readCard = deps.approvals?.readCard;
      if (!postCard || !readCard) throw new Error("ADE can't update cards in this chat here.");
      return await oneAtATime(`${chatSessionId}\0${requestId}`, async () => {
        const card = await readCard(chatSessionId, cloudTierRequestCardId(requestId));
        const request = card ? cloudTierRequestOfCard(card, chatSessionId) : null;
        if (!card || !request) throw new Error("This chat has no such ADE Cloud size request.");
        // The yes that arrives after its change already ended changes nothing.
        if (!outcome && answer !== "dismiss" && cloudTierRequestAnswerOfCard(card)?.outcome) return { answered: true, toldAgent: false };
        const told = cloudTierRequestToldKey(answer, outcome);
        const toldBefore = cloudTierRequestToldOfCard(card);
        if (toldBefore === told) return { answered: true, toldAgent: false };
        const message = cloudTierRequestAgentMessage(request, { answer, outcome, error });
        const deliver = (message.via === "wake" ? deps.approvals?.tellAgent : deps.approvals?.noteForNextTurn) ?? null;
        const answered = (toldNow: string | null) => buildCloudTierRequestAnsweredCard(card, request, { answer, outcome, error, told: toldNow });
        // Shown at once, and marked told before the send: a report of the same end meanwhile is a no-op.
        await postCard(chatSessionId, answered(deliver ? told : toldBefore));
        if (!deliver) return { answered: true, toldAgent: false };
        try {
          await deliver(chatSessionId, message.text);
        } catch (tellError) {
          // Not told: the mark goes, so the next report (or the person's try again) tells it.
          await postCard(chatSessionId, answered(toldBefore)).catch((postError: unknown) => {
            logger.warn?.("cloud.tier_request_unmark_failed", { error: getErrorMessage(postError) });
          });
          logger.warn?.("cloud.tier_request_tell_failed", { answer, outcome, via: message.via, error: getErrorMessage(tellError) });
          throw tellError;
        }
        logger.info?.("cloud.tier_request_answered", { answer, outcome, via: message.via });
        return { answered: true, toldAgent: true };
      });
    },
  };
  return { actions };
}
