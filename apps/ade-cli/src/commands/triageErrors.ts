/**
 * The two failures `ade triage` reports to the user, kept in their own module
 * so every triage module can throw them without importing each other.
 *
 * Both are structured on purpose: `cli.ts` maps them onto its own error types,
 * which print the message alone. A bare `Error` reaches the catch-all instead
 * and prints a stack trace over the wording — on the one machine whose owner is
 * least able to read one.
 */

/** A bad `--provider` and friends: usage, mapped to `CliUsageError`. */
export class TriageUsageError extends Error {}

/**
 * The command could not produce the handoff — the temp directory is full or
 * read-only, or the agent CLI could not be spawned. Mapped to `CliToolError`.
 */
export class TriageCommandError extends Error {}
