import type { AgentChatEvent } from "./types/chat";

export const LAUNCH_DELIVERY_ERROR_METADATA_KEY = "launchDeliveryError";

export type UserMessageStatusTone = "muted" | "warning" | "error";

export type UserMessageStatus = {
  kind:
    | "steering"
    | "steered"
    | "sent_after_turn"
    | "steer_unprocessed"
    | "steer_failed"
    | "send_failed"
    | "launch_retrying";
  label: string;
  tone: UserMessageStatusTone;
  icon: "steer" | "clock" | "warning";
  title?: string;
};

type UserMessageEvent = Extract<AgentChatEvent, { type: "user_message" }>;

/** The one-line delivery state shown next to a user message on every client. */
export function describeUserMessageStatus(event: UserMessageEvent): UserMessageStatus | null {
  const isSteer = Boolean(event.steerId?.trim());
  switch (event.deliveryState) {
    case "failed": {
      const launchDeliveryError = event.metadata?.[LAUNCH_DELIVERY_ERROR_METADATA_KEY];
      if (typeof launchDeliveryError === "string" && launchDeliveryError.trim()) {
        return {
          kind: "launch_retrying",
          label: "Couldn't send — retrying",
          tone: "warning",
          icon: "warning",
          title: launchDeliveryError,
        };
      }
      return isSteer
        ? { kind: "steer_failed", label: "Steer failed", tone: "error", icon: "steer" }
        : { kind: "send_failed", label: "Couldn't send", tone: "error", icon: "warning" };
    }
    case "unprocessed":
      return {
        kind: "steer_unprocessed",
        label: "Not steered — turn ended first",
        tone: "warning",
        icon: "steer",
        title: "The turn finished before the agent read this message.",
      };
    case "inline":
      return {
        kind: "steered",
        label: "Steered",
        tone: "muted",
        icon: "steer",
        title: "Sent into the running turn.",
      };
    case "processed":
      return {
        kind: "steered",
        label: "Steered",
        tone: "muted",
        icon: "steer",
        title: "The agent read this during the running turn.",
      };
    case "accepted":
      return {
        kind: "steering",
        label: "Steering…",
        tone: "muted",
        icon: "steer",
        title: "Offered to the running turn; the agent has not read it yet.",
      };
    case "delivered":
      return isSteer
        ? {
          kind: "sent_after_turn",
          label: "Sent after turn",
          tone: "muted",
          icon: "clock",
          title: "Queued during a turn and sent when it finished.",
        }
        : null;
    case "queued":
      return null;
    case undefined:
      return isSteer && event.processed === true
        ? { kind: "steered", label: "Steered", tone: "muted", icon: "steer" }
        : null;
    default: {
      const _exhaustive: never = event.deliveryState;
      void _exhaustive;
      return null;
    }
  }
}
