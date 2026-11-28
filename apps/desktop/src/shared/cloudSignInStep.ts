import { BRAND } from "./brand";

/**
 * The words of a cloud start's sign-in step (a launch's `signIn`, or a queued
 * message's), the same on the desktop card, the web card and the queued
 * message card. The phone follows the same list
 * (`briefs/cloud-first-sign-in-phone.md`). What the wait costs and whether a
 * free model is offered are the server's answers; nothing here decides them.
 */
export type CloudSignInStepFacts = {
  label: string;
  url: string | null;
  userCode: string | null;
  reason: string | null;
  jobId?: string | null;
  needsPastedCode?: boolean;
  provider?: string | null;
  expiresAt?: number | null;
  freeModel?: { modelId: string; label: string } | null;
  ownComputer?: boolean;
  charge?: { free: boolean; sentence: string } | null;
};

export type CloudSignInStepWords = {
  title: string;
  /** What to do, at most two sentences; null when the `reason` says it (an API key, a desktop-only sign-in). */
  instruction: string | null;
  /** What changed or failed, from the computer; shown whenever set. */
  reason: string | null;
  /** "You have 30 minutes.", from `expiresAt`, rounded down; null without one or once it passed. */
  timeLeft: string | null;
  /** The server's cost line, as sent. */
  charge: string | null;
  freeModelButton: string | null;
  freeModelNote: string | null;
  ownComputer: string | null;
};

export const CLOUD_SIGN_IN_FREE_MODEL_NOTE = "Free with ads, on this computer.";

function timeLeftOf(expiresAt: number | null | undefined, now: number): string | null {
  if (expiresAt == null || !Number.isFinite(expiresAt)) return null;
  const minutes = Math.floor((expiresAt - now) / 60_000);
  if (expiresAt <= now) return null;
  if (minutes < 1) return "Less than a minute left.";
  return minutes === 1 ? "You have 1 minute." : `You have ${minutes} minutes.`;
}

export function cloudSignInStepWords(signIn: CloudSignInStepFacts, now: number): CloudSignInStepWords {
  const pastes = signIn.needsPastedCode === true && Boolean(signIn.jobId);
  const instruction = signIn.userCode
    ? `Open the page and type this code: ${signIn.userCode}`
    : pastes
      ? signIn.provider === "claude"
        ? "Open sign-in, then paste the code it shows here. It needs a Claude subscription."
        : "Open sign-in, then paste the code it shows here."
      : null;
  return {
    title: `Sign in to ${signIn.label} to start the chat`,
    instruction,
    reason: signIn.reason?.trim() || null,
    timeLeft: timeLeftOf(signIn.expiresAt, now),
    charge: signIn.charge?.sentence?.trim() || null,
    freeModelButton: signIn.freeModel ? `Start with ${signIn.freeModel.label} instead` : null,
    freeModelNote: signIn.freeModel ? CLOUD_SIGN_IN_FREE_MODEL_NOTE : null,
    ownComputer: signIn.ownComputer
      ? `Signed in on your own computer? Turn on Share my sign-ins in Settings › ${BRAND.CLOUD_NAME}, and this step goes away.`
      : null,
  };
}
