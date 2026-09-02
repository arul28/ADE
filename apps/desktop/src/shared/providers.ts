/**
 * The one closed list of providers ADE ships.
 *
 * `AgentChatProvider` widens to `string` for forward compatibility, which would
 * let a new provider be added with no row in any per-provider table. This narrow
 * union makes such an omission a compile error instead: every per-provider table
 * is declared `as const satisfies Record<ShippedProvider, …>`, so a member added
 * here without a row is caught where the row is missing.
 */
export type ShippedProvider = "claude" | "codex" | "cursor" | "droid" | "opencode" | "pi";
