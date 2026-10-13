/**
 * The one closed list of providers ADE ships.
 *
 * `AgentChatProvider` widens to `string` for forward compatibility, which would
 * let a new provider be added with no row in any per-provider table. This narrow
 * union makes such an omission a compile error instead: every per-provider table
 * is declared `as const satisfies Record<ShippedProvider, …>`, so a member added
 * here without a row is caught where the row is missing.
 */
export type ShippedProvider = "claude" | "codex" | "cursor" | "droid" | "opencode" | "pi" | "muse";

/**
 * The name a person reads for a shipped provider. Surfaces that show a provider
 * name use this row rather than a local table, so Muse is "Muse Code" everywhere.
 * Short chips that need a two-letter code keep their own code.
 */
export const PROVIDER_DISPLAY_NAME = {
  muse: "Muse Code",
} as const satisfies Partial<Record<ShippedProvider, string>>;

/**
 * The arguments that run Muse's sign-in in an ADE terminal, after the pinned
 * `muse` binary. Shared so the renderer's sign-in command and the main process
 * agree on it.
 */
export const MUSE_LOGIN_ARGS = ["login"] as const;

/** The sign-in command as a person types it, for copy: `muse login`. */
export const MUSE_LOGIN_COMMAND = ["muse", ...MUSE_LOGIN_ARGS].join(" ");
