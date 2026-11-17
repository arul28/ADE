/**
 * ADE Cloud is one machine that every account always has. Each cloud lane has
 * its own computer underneath, but the person sees one machine, "ADE Cloud",
 * in every machine list and Run on menu, on the desktop, the web and the
 * iPhone. These constants name that one machine.
 *
 * Every action on a cloud lane still goes to that lane's own computer (its
 * pin). Only the label and the grouping are shared.
 */

/** The machine id of ADE Cloud in machine lists and the Run on menu. */
export const ADE_CLOUD_MACHINE_ID = "__ade_cloud__";

/** The name a person sees for ADE Cloud, everywhere. */
export const ADE_CLOUD_NAME = "ADE Cloud";

/**
 * What a window knows about ADE Cloud for the signed-in account:
 * - `on`: it can read and do.
 * - `blocked`: it can read its saved work, but not wake or start anything
 *   (out of the server's allow list). `reason` holds the server's sentence.
 * - `signed_out`: no ADE account here, so nothing to show.
 * - `unknown`: no answer yet. ADE Cloud still shows; the server refuses an
 *   action it can't do, with its sentence.
 */
export type AdeCloudAccessState = "on" | "blocked" | "signed_out" | "unknown";

/**
 * `window.ade.cloudAccess.read()`'s answer. `enabled` is what old renderers
 * read. `state`, `reason` and `account` are added; an old main process or a
 * web adapter that sends only `enabled` reads as on or blocked.
 */
export type CloudAccessIpcAnswer = {
  enabled: boolean;
  state?: AdeCloudAccessState;
  reason?: string | null;
  /** The account the answer is for, so a window keeps the last answer per account. */
  account?: string | null;
  signInEnd?: import("./cloudSignIns").CloudSignInEnd | null;
};

/** The sentence when ADE is signed out here. */
export const ADE_CLOUD_SIGNED_OUT_SENTENCE = "Sign in to ADE to use ADE Cloud.";

/** The sentence for a blocked account when the server sent none (an old server). */
export const ADE_CLOUD_BLOCKED_SENTENCE = "ADE Cloud is turned off for this account. Contact ADE support if you think this is a mistake.";
