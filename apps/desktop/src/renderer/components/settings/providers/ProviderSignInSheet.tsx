/**
 * The one sign-in sheet for Settings and first setup: the provider's header,
 * the account note, three steps, the code, the paste box, and the end states
 * (`signInSheetParts`). In a chat there is no sheet; the chat card
 * (`chat/ProviderSignInCard`) draws the same parts in the prompt box's place.
 *
 * Each provider keeps its own flow, with the same calls, the same machine and
 * the same states as before; only the screen is shared:
 *
 * - Claude Code and Codex: an account's own login in a private PTY on its
 *   machine (`providerInstances.login*`). `AccountSignInSheet`.
 * - Grok, Devin, Muse, Copilot, Droid, Kimi: the CLI's own login run by ADE
 *   (`ai.cliLogin*`). `CliSignInSheet`.
 * - Qwen, and those CLIs on a machine whose ADE is too old for the above: the
 *   login command in a terminal inside step 2 (`pty.create`).
 *   `TerminalSignInSheet`.
 * - Antigravity and Cursor: their owners keep the flow (the Settings page,
 *   the setup card) and render `AntigravitySignInSheetView` or
 *   `CursorSignInSheetView`.
 *
 * Every call of one sign-in goes to the machine its `pin` names: the start,
 * its status reads, a pasted code and the cancel. Closing a sheet mid-flow
 * (Cancel, Esc, the ×) stops the sign-in there.
 *
 * Each flow has its own file, drawn in the shared frame (`signInSheetFrame`).
 * This file keeps the Antigravity and Cursor views and re-exports the rest.
 */
import { useState } from "react";
import { isAntigravitySignInRunning, type AntigravitySignInState } from "../../../../shared/types";
import { signInAccountMismatch, signInMachineWords, type SignInStage } from "./signInSheetParts";
import { SignInSheetFrame, useSuccessHold, type SignInMachine, type SignInSheetView } from "./signInSheetFrame";


// ─────────────────────────────────────────────────────────────────────────────
// Antigravity (its owner keeps the flow)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sheet for an Antigravity sign-in. The Settings page and the setup card
 * each run the flow (`ai.antigravitySignIn*` on their pin); this draws its
 * state. Antigravity names no account, so the note asks the person to check
 * it on Google's page.
 */
export function AntigravitySignInSheetView({
  state,
  starting,
  machine,
  submitting,
  onSubmitAddress,
  onClose,
  onTryAgain,
  error,
}: {
  state: AntigravitySignInState | null;
  /** The start call is in flight (no state for it yet). */
  starting: boolean;
  machine: SignInMachine;
  submitting: boolean;
  /** Hand the address the browser ended on to the agent. */
  onSubmitAddress: (address: string) => void;
  /** Close; the owner stops a running flow first. */
  onClose: () => void;
  onTryAgain?: () => void;
  error?: string | null;
}) {
  const [address, setAddress] = useState("");
  const phase = state?.phase ?? "idle";
  const stage: SignInStage = starting || phase === "starting" || (phase === "idle" && !error)
    ? "starting"
    : phase === "waiting"
      ? "waiting"
      : phase === "verifying"
        ? "verifying"
        : phase === "succeeded"
          ? "done"
          : "failed";
  useSuccessHold(stage, onClose);
  const view: SignInSheetView = {
    stage,
    url: state?.authorizationUrl ?? null,
    deviceCode: null,
    // A Google-account sign-in ends on Google's page that shows a code, on
    // every machine. Gemini Enterprise returns to the agent's own listener.
    codeHint: state?.acceptsCallbackUrl
      ? "Google shows a code once you approve. Paste it below."
      : machine.isThisMachine
        ? "Google sends the browser back to Antigravity by itself."
        : `Finish in a browser on ${machine.machineName}: Google sends it back to an address there.`,
    paste: state?.acceptsCallbackUrl && isAntigravitySignInRunning(state)
      ? {
          label: "Paste the code Google shows",
          placeholder: "Paste the code here",
          value: address,
          onChange: setAddress,
          onSubmit: () => {
            const value = address.trim();
            if (!value) return;
            setAddress("");
            onSubmitAddress(value);
          },
          submitting,
          submitLabel: "Continue",
        }
      : null,
    stepExtra: state?.licensePickerUrl ? (
      <span className="ade-sis-hint">
        Then choose your license on the page Antigravity serves. It opens only in a browser on {signInMachineWords(machine.isThisMachine, machine.machineName)}: <code>{state.licensePickerUrl}</code>
      </span>
    ) : null,
    expectedAccount: null,
    account: null,
    error: stage === "failed" ? null : error ?? null,
    failure: stage === "failed"
      ? phase === "cancelled"
        ? { title: "The sign-in was stopped.", detail: state?.message ?? null, stopped: true }
        : { title: error && phase !== "failed" ? "The sign-in could not start." : "Sign-in did not complete.", detail: error ?? state?.message ?? null }
      : null,
  };
  return (
    <SignInSheetFrame
      providerId="antigravity"
      providerLabel="Antigravity"
      title="Sign in to Antigravity"
      machine={machine}
      view={view}
      onClose={onClose}
      onTryAgain={onTryAgain}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor (its owner keeps the flow)
// ─────────────────────────────────────────────────────────────────────────────

/** How a Cursor sign-in ended, as its owner reports it. */
export type CursorSignInOutcome = { ok: boolean; email?: string | null; error?: string | null };

/**
 * The sheet for a Cursor sign-in. The owner runs `ai.cursorAuthLogin` on its
 * pin (Settings also checks the new key); this draws where it is.
 */
export function CursorSignInSheetView({
  running,
  verifying,
  loginUrl,
  outcome,
  expectedAccount,
  machine,
  onClose,
  onTryAgain,
}: {
  running: boolean;
  verifying: boolean;
  /** The sign-in page Cursor reported, when the owner knows it. */
  loginUrl: string | null;
  outcome: CursorSignInOutcome | null;
  expectedAccount: string | null;
  machine: SignInMachine;
  onClose: () => void;
  onTryAgain: () => void;
}) {
  const account = outcome?.ok ? outcome.email?.trim() || null : null;
  const stage: SignInStage = outcome
    ? outcome.ok
      ? signInAccountMismatch(expectedAccount, account) ? "mismatch" : "done"
      : "failed"
    : verifying
      ? "verifying"
      : running && loginUrl
        ? "waiting"
        : "starting";
  useSuccessHold(stage, onClose);
  const view: SignInSheetView = {
    stage,
    startHint: running ? "Cursor opens its sign-in page in your browser…" : null,
    url: loginUrl,
    deviceCode: null,
    codeHint: "Sign in on Cursor's page. ADE makes a Cursor key for itself; it does not copy Cursor app cookies.",
    expectedAccount,
    account,
    failure: outcome && !outcome.ok ? { title: "Sign-in did not complete.", detail: outcome.error || "Cursor sign-in failed." } : null,
  };
  return (
    <SignInSheetFrame
      providerId="cursor"
      providerLabel="Cursor"
      title="Sign in to Cursor"
      machine={machine}
      view={view}
      onClose={onClose}
      onTryAgain={onTryAgain}
      onKeep={onClose}
    />
  );
}
