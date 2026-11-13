/**
 * `providerMetadata` key on the card that asks the person before an agent's
 * text goes out (`messages.send`). Its presence makes the card person-only:
 * an agent cannot approve its own text.
 */
export const MESSAGES_SEND_APPROVAL_METADATA_KEY = "messagesSendApproval" as const;
