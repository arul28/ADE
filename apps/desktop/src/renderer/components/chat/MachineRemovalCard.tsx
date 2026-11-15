import { useState } from "react";
import { AppleLogo, Desktop, LinuxLogo, SpinnerGap, Trash, Warning, WindowsLogo } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import {
  MACHINE_REMOVAL_EFFECT,
  machineRemovalAnswersApprove,
  machineRemovalKeepAnswers,
  machineRemovalRemoveAnswers,
  type MachineRemovalRequestCard,
} from "../../../shared/machineRemovalRequest";
import { cardAskerFamily, providerDisplayName } from "../../../shared/pendingInputLabels";
import { relativeWhen } from "../../lib/format";
import { CardError, CardHeading, CardReceipt, cardEscapeHandler } from "./composerCardParts";
import "./machineRemovalCard.css";

/**
 * The computer removal card.
 *
 * An agent runs `ade machines remove <computer>` in its chat. Agents may not
 * remove a computer, so the brain asks here instead. The card takes the
 * composer's place: which computer, its platform, when it last checked in,
 * whether it is online, and what removal does. Keep is the default; Remove
 * answers with the person's decision, and the brain on the chat's machine
 * removes the computer before the card closes. A failure keeps the card open
 * with the reason.
 *
 * Removing a computer that is online, or the one this chat runs on, cuts off
 * work in use, so Remove arms first: the row turns into a warning and a
 * "Remove anyway" button, and only that second press answers.
 */

function PlatformMark({ platform }: { platform: string | null }) {
  const value = platform?.toLowerCase() ?? "";
  if (value.includes("mac") || value.includes("darwin")) return <AppleLogo size={17} weight="fill" />;
  if (value.includes("win")) return <WindowsLogo size={17} weight="fill" />;
  if (value.includes("linux")) return <LinuxLogo size={17} weight="fill" />;
  return <Desktop size={17} weight="duotone" />;
}

function lastSeenText(card: MachineRemovalRequestCard): string {
  if (card.online) return "Checked in just now";
  if (card.lastSeenAt == null) return "Never checked in";
  return `Last seen ${relativeWhen(new Date(card.lastSeenAt).toISOString())}`;
}

function armedWarning(card: MachineRemovalRequestCard): string {
  return card.isThisComputer
    ? `${card.name} runs this chat. Removing it takes this ADE off your account until someone signs in here again.`
    : `${card.name} is online. Its chats and terminals stop being reachable from your other devices.`;
}

export function MachineRemovalComposer({
  request,
  card,
  responding,
  error,
  onAnswer,
  chatProvider,
}: {
  request: PendingInputRequest;
  card: MachineRemovalRequestCard;
  responding: boolean;
  /** Why the last Remove did not go through, from the host. */
  error: string | null;
  /** Sends the person's answer: Keep, or Remove (with the second yes when asked). */
  onAnswer: (answers: Record<string, string[]>) => void;
  chatProvider?: string | null;
}) {
  const [armed, setArmed] = useState(false);
  const askerFamily = cardAskerFamily(request.source, chatProvider);
  const asker = providerDisplayName(askerFamily);
  const keep = () => {
    if (!responding) onAnswer(machineRemovalKeepAnswers());
  };
  const remove = () => {
    if (responding) return;
    if (card.needsConfirm && !armed) {
      setArmed(true);
      return;
    }
    onAnswer(machineRemovalRemoveAnswers(card));
  };
  const onKeyDown = cardEscapeHandler({
    responding,
    // Esc steps back from the armed warning before it says Keep.
    onDecline: () => (armed ? setArmed(false) : keep()),
  });

  return (
    <div
      role="group"
      aria-label={`${asker} asks to remove the computer ${card.name} from your ADE account`}
      data-testid="machine-removal-composer"
      data-machine={card.machineKey}
      data-armed={armed ? "true" : undefined}
      className="ade-icc ade-mrc"
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="ade-icc-banner ade-mrc-banner">
        <span className="ade-icc-logo">
          <span className="ade-mrc-tile" aria-hidden><PlatformMark platform={card.platform} /></span>
        </span>
        <CardHeading askerFamily={askerFamily} asker={asker} verb="asks to remove" title={card.name} />
        <span className="ade-icc-banner-tools">
          {card.isThisComputer ? (
            <span className="ade-icc-chip" data-tone="warn" data-testid="machine-removal-this-computer">This computer</span>
          ) : null}
          <span className="ade-icc-chip ade-mrc-presence" data-online={card.online ? "true" : "false"} data-testid="machine-removal-presence">
            <span className="ade-mrc-dot" aria-hidden />
            {card.online ? "Online" : "Offline"}
          </span>
        </span>
      </div>

      <div className="ade-icc-body">
        <p className="ade-mrc-facts" data-testid="machine-removal-facts">
          {card.platform ? <span>{card.platform}</span> : null}
          {card.install ? <span>{card.install}</span> : null}
          <span>{lastSeenText(card)}</span>
        </p>
        <p className="ade-icc-reason">{MACHINE_REMOVAL_EFFECT}</p>

        <div className="ade-icc-row ade-mrc-row">
          {armed ? (
            <span className="ade-mrc-warning" role="alert" data-testid="machine-removal-warning">
              <Warning size={13} weight="fill" aria-hidden />
              {armedWarning(card)}
            </span>
          ) : (
            <span className="ade-mrc-spacer" />
          )}
          <button
            type="button"
            className="ade-icc-link ade-icc-link-dim ade-mrc-keep"
            disabled={responding}
            autoFocus
            data-testid="machine-removal-keep"
            onClick={armed ? () => setArmed(false) : keep}
          >
            {armed ? "Cancel" : "Keep"}
          </button>
          <button
            type="button"
            className="ade-icc-primary ade-mrc-remove"
            data-armed={armed ? "true" : undefined}
            disabled={responding}
            autoFocus={armed}
            data-testid="machine-removal-remove"
            onClick={remove}
          >
            {responding ? <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" /> : <Trash size={12} weight="bold" />}
            {responding ? "Removing…" : armed ? "Remove anyway" : "Remove"}
          </button>
        </div>

        {error ? <CardError id="machine-removal-error" message={error} /> : null}
      </div>
    </div>
  );
}

/** The transcript record: one line while the card waits, then what the person chose. */
export function MachineRemovalReceipt({
  card,
  resolution,
  answers,
}: {
  card: MachineRemovalRequestCard;
  resolution: "accepted" | "declined" | "cancelled" | null;
  answers?: Record<string, string | string[]> | undefined;
}) {
  const logo = (
    <span className="ade-icc-receipt-logo ade-mrc-receipt-logo" aria-hidden>
      <PlatformMark platform={card.platform} />
    </span>
  );
  if (resolution === null) {
    return <CardReceipt testId="machine-removal-receipt-open" logo={logo} state="open" before="Remove computer " name={card.name} />;
  }
  const answerMap: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(answers ?? {})) answerMap[id] = Array.isArray(value) ? value : [value];
  // The brain removed it only for an explicit Remove (with the second yes when asked).
  const removed = resolution === "accepted" && machineRemovalAnswersApprove(card, answerMap);
  const text = removed
    ? "removed from your ADE account"
    : resolution === "cancelled" ? "· closed before it was answered" : "· kept";
  return (
    <CardReceipt
      testId="machine-removal-receipt"
      logo={logo}
      state={removed ? "done" : "not-done"}
      before={removed ? undefined : "Remove computer "}
      name={card.name}
      after={text}
    />
  );
}
