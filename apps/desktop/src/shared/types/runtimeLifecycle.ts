/**
 * Why a project runtime is going away, for the services whose teardown
 * depends on it.
 *
 * - `"exit"`: this process is stopping (a brain restart, an update, a signal).
 *   The next brain runs the same project, so a device service hands its
 *   devices off instead of stopping them.
 * - `"close"`: this process stays up but lets the project's runtime go for a
 *   reason that is not the user's (a repair, a superseded boot). The next
 *   runtime for the project re-adopts what was handed off, so this hands off
 *   too.
 * - `"unregister"`: the project was removed from this machine. Nothing will
 *   adopt its devices, so they are stopped.
 *
 * A caller that does not know (`undefined`) keeps each service's configured
 * default.
 */
export type RuntimeDisposeReason = "exit" | "close" | "unregister";
