/** The Messages integration's switches on one Mac (Settings › Integrations › Messages). */
export type MessagesIntegrationSettings = {
  /** The person connected Messages on this Mac. Off until they do. */
  connected: boolean;
  /** Agents may read texts (on by default once connected). */
  readTexts: boolean;
  /** Agents may send texts, each one approved on a card (on by default once connected). */
  sendTexts: boolean;
  /** Texts go without the approval card (off by default). */
  sendWithoutAsking: boolean;
};

export type MessagesIntegrationStatus = MessagesIntegrationSettings & {
  /** A Mac with the Messages reader. */
  supported: boolean;
  /** Whether ADE can read the Messages database now. */
  access: "ok" | "needs_full_disk_access" | "no_database" | "unsupported" | "error";
};
