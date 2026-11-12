/**
 * Claude on cloud machines, signed in once.
 *
 * Claude Code has a sign-in made for headless machines: `claude setup-token`
 * prints a long-lived subscription token (a "pass"), and
 * `CLAUDE_CODE_OAUTH_TOKEN` signs Claude Code in with it. The person runs it
 * once, here, in a private PTY: the browser approves it, and ADE reads the
 * token from Claude Code's output and keeps it in the account vault
 * (claudePassStore.ts; cloudSignInStore.ts for the single item of older
 * versions).
 *
 * The browser can be signed in to another Claude account than the one the
 * person pressed. When the caller names that account, ADE asks Claude Code
 * which account the pass is for (claudePassVerify.ts) before it saves. Another
 * account waits for the person in `mismatch`: Keep it, or try again. A pass
 * nobody keeps is dropped after 10 minutes.
 *
 * This runs in the brain (`ade serve`), never in the desktop's main process:
 * the brain loads node-pty from a real folder, while inside a packaged app
 * node-pty's helper sits in app.asar and can't be spawned or repaired. The
 * token never leaves the brain except for the vault and the one check: it is
 * cut from the output before anything reads it, and never logged.
 *
 * One sign-in per machine; a start replaces a running one.
 */

import type { ClaudePassCheck, ClaudePassLabelSource, ClaudePassUpload, CloudSignInStatus } from "../../../shared/cloudSignIns";
import { AdeExpectedError } from "../../../shared/expectedError";
import {
  LOGIN_TIMEOUT_MS,
  cleanLoginOutput,
  readLoginOutput,
  writeLoginCode,
} from "../shared/cliLoginPty";
import type { AgentCliLoginCliState, AgentCliLoginPty } from "../ai/agentCliLoginRunner";
import { COMPLETE_CLAUDE_TOKEN_PATTERN, CLAUDE_TOKEN_PATTERN } from "./cloudSignInStore";
import type { ClaudePassVerifyResult } from "./claudePassVerify";

const AUTH_HOSTS = ["claude.ai", "anthropic.com", "claude.com"];

/** A pass the check named for another account waits this long for Keep. */
export const CLAUDE_PASS_MISMATCH_HOLD_MS = 10 * 60_000;

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

type ClaudeState = NonNullable<CloudSignInStatus["claude"]>;

/** Which account a saved pass is labelled with, and how ADE knows. */
export type ClaudePassSaveOutcome = {
  email: string | null;
  check: ClaudePassCheck;
  labelSource: ClaudePassLabelSource;
};

/**
 * False: the account refused it. `{ key }`: kept under that vault key;
 * `upload` other than "account" means it is only on this computer so far.
 */
export type ClaudePassSaveResult = boolean | { key: string; upload?: ClaudePassUpload };

/** Why a kept pass is not in the account yet, in one sentence. */
export function claudePassUploadMessage(upload: ClaudePassUpload): string | null {
  if (upload === "refused") {
    return "Your ADE account doesn't take Claude passes yet. ADE keeps the pass on this computer and tries again every hour.";
  }
  if (upload === "pending") {
    return "ADE couldn't reach your account yet. The pass is kept on this computer, and ADE sends it on its own.";
  }
  return null;
}

export type ClaudeSignInStartOptions = {
  /** The account the person pressed "Sign in" for; null for "Another account". */
  forEmail?: string | null;
  /** The pass a Renew replaces. */
  renewKey?: string | null;
  /** An email the person typed as the label (open owner question; unused by the UI today). */
  labelEmail?: string | null;
  /** Ask Claude Code which account the pass is for before it is saved. */
  check?: boolean;
};

type SignInRecord = {
  status: { state: ClaudeState["state"]; output: string; url: string | null; awaitingCode: boolean; checkingCode?: boolean };
  message: string | null;
  pty: AgentCliLoginPty | null;
  rawOutput: string;
  submittedCodes: string[];
  rawSinceSubmit: string | null;
  timeout: ReturnType<typeof setTimeout> | null;
  options: ClaudeSignInStartOptions;
  /** Keeps the token; false when the account refused it. */
  save: (token: string, outcome: ClaudePassSaveOutcome) => Promise<ClaudePassSaveResult>;
  /** The save of the token read, while it runs. */
  saving: Promise<unknown> | null;
  /** Stops a check that runs. */
  verifyAbort: AbortController | null;
  /** The pass waiting in `mismatch`, in memory only; cleared by every end. */
  heldToken: string | null;
  foundEmail: string | null;
  check: ClaudePassCheck | null;
  savedKey: string | null;
  upload: ClaudePassUpload | null;
};

export type CloudClaudeSignInDeps = {
  /** ADE's pinned Claude Code on this machine. Never one from the PATH. */
  resolveCli: () => AgentCliLoginCliState;
  /** The environment the CLI runs with (the user's, without ADE's host variables). */
  baseEnv: () => NodeJS.ProcessEnv;
  spawnPty: (command: string, args: string[], env: NodeJS.ProcessEnv) => AgentCliLoginPty;
  /** Stops the CLI; `sync` on process exit, which can't wait. */
  stopPty: (pty: AgentCliLoginPty, options: { sync?: boolean }) => void;
  /** Which account a pass is for. Without it, a start asked to check saves as unchecked. */
  verify?: (token: string, options: { signal: AbortSignal }) => Promise<ClaudePassVerifyResult>;
  logger?: Logger;
};

function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

export function createCloudClaudeSignIn(deps: CloudClaudeSignInDeps) {
  let record: SignInRecord | null = null;

  const live = (candidate: SignInRecord | null): candidate is SignInRecord =>
    candidate != null && (
      candidate.status.state === "running"
      || candidate.status.state === "verifying"
      || candidate.status.state === "mismatch"
      || candidate.status.state === "saving"
    );

  function stopPtyOf(target: SignInRecord, options: { sync?: boolean } = {}) {
    const pty = target.pty;
    target.pty = null;
    if (pty) deps.stopPty(pty, options);
  }

  function end(target: SignInRecord, state: ClaudeState["state"], message: string | null = null, options: { sync?: boolean } = {}) {
    target.status.state = state;
    target.status.awaitingCode = false;
    target.status.checkingCode = false;
    target.message = message;
    target.heldToken = null;
    if (target.timeout) clearTimeout(target.timeout);
    target.timeout = null;
    target.verifyAbort?.abort();
    target.verifyAbort = null;
    stopPtyOf(target, options);
  }

  function setTimer(target: SignInRecord, ms: number, onFire: () => void) {
    if (target.timeout) clearTimeout(target.timeout);
    target.timeout = setTimeout(onFire, ms);
    target.timeout.unref?.();
  }

  /** Saves the pass with its label; the token is never kept after this. */
  function saveAs(target: SignInRecord, token: string, outcome: ClaudePassSaveOutcome) {
    target.status.state = "saving";
    target.check = outcome.check;
    target.heldToken = null;
    target.saving = target.save(token, outcome).then(
      (result) => {
        if (record !== target || target.status.state !== "saving") return;
        if (!result) {
          end(target, "failed", "ADE couldn't save the pass to your account. Sign in to ADE on this computer, then try again.");
          return;
        }
        target.savedKey = typeof result === "object" ? result.key : null;
        target.upload = typeof result === "object" ? result.upload ?? "account" : null;
        deps.logger?.info?.("cloud.claude_token_saved", { check: outcome.check, upload: target.upload });
        // Kept, but not in the account: never shown as signed in.
        if (target.upload && target.upload !== "account") {
          end(target, "saved_here", claudePassUploadMessage(target.upload));
          return;
        }
        end(target, "succeeded");
      },
      () => {
        if (record !== target || target.status.state !== "saving") return;
        deps.logger?.warn?.("cloud.claude_token_save_threw", { reason: "vault_write_threw" });
        end(target, "failed", "ADE couldn't save the pass to your account. Try again.");
      },
    );
  }

  /** The label when Claude Code named no account. */
  function uncheckedOutcome(options: ClaudeSignInStartOptions): ClaudePassSaveOutcome {
    const pressed = options.forEmail?.trim() || null;
    if (pressed) return { email: pressed, check: "unchecked", labelSource: "pressed" };
    const typed = options.labelEmail?.trim() || null;
    if (typed) return { email: typed, check: "unchecked", labelSource: "typed" };
    return { email: null, check: "unchecked", labelSource: "none" };
  }

  function verifyThenSave(target: SignInRecord, token: string) {
    // Claude Code printed the pass; nothing more to read from its sign-in.
    stopPtyOf(target);
    target.status.state = "verifying";
    const verify = deps.verify;
    if (!verify) {
      saveAs(target, token, uncheckedOutcome(target.options));
      return;
    }
    const abort = new AbortController();
    target.verifyAbort = abort;
    void verify(token, { signal: abort.signal }).then(
      (result) => {
        if (record !== target || target.status.state !== "verifying") return;
        target.verifyAbort = null;
        if (result.kind !== "email") {
          saveAs(target, token, uncheckedOutcome(target.options));
          return;
        }
        target.foundEmail = result.email;
        const pressed = target.options.forEmail?.trim() || null;
        if (!pressed || sameEmail(pressed, result.email)) {
          saveAs(target, token, { email: result.email, check: "match", labelSource: "checked" });
          return;
        }
        // Another account than the pressed one: the person decides.
        target.status.state = "mismatch";
        target.check = "kept_other";
        target.heldToken = token;
        deps.logger?.info?.("cloud.claude_pass_mismatch");
        setTimer(target, CLAUDE_PASS_MISMATCH_HOLD_MS, () => {
          if (record !== target || target.status.state !== "mismatch") return;
          deps.logger?.info?.("claude_pass.dropped", { reason: "not_kept" });
          end(target, "cancelled", "ADE dropped the pass for the other account, since nobody kept it.");
        });
      },
      () => {
        // verifyClaudePass never throws; a fake or future one may.
        if (record !== target || target.status.state !== "verifying") return;
        target.verifyAbort = null;
        saveAs(target, token, uncheckedOutcome(target.options));
      },
    );
  }

  /** Cuts the token from everything that reads the output, then checks or keeps it. */
  function take(target: SignInRecord, token: string) {
    target.submittedCodes.push(token);
    target.status.output = cleanLoginOutput(target.rawOutput, target.submittedCodes);
    target.rawOutput = "";
    target.status.awaitingCode = false;
    if (target.options.check) {
      verifyThenSave(target, token);
      return;
    }
    saveAs(target, token, uncheckedOutcome(target.options));
  }

  function spawn(target: SignInRecord, cli: { command: string; leadingArgs: string[]; env: Record<string, string> }) {
    const env: NodeJS.ProcessEnv = { ...deps.baseEnv(), ...cli.env, TERM: "xterm-256color" };
    // The token being made must not be confused with one already set here.
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    // Settings opens the printed link, and Claude Code would open a second
    // page of its own. It runs $BROWSER with the link; `true` opens nothing
    // (on Windows the command is missing, which it also takes as no page).
    env.BROWSER = "true";
    let pty: AgentCliLoginPty;
    try {
      pty = deps.spawnPty(cli.command, [...cli.leadingArgs, "setup-token"], env);
    } catch (error) {
      end(target, "failed", `Couldn't start Claude Code's sign-in: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    target.pty = pty;
    pty.onData((data) => {
      if (record !== target || target.status.state !== "running") return;
      // The printed link ends in a code to paste, so the box stays up while it waits.
      const { text, rejection } = readLoginOutput(target, data, { hosts: AUTH_HOSTS, deviceCode: false, pasteCode: "while-waiting", promptTailLines: 4 });
      const token = COMPLETE_CLAUDE_TOKEN_PATTERN.exec(text)?.[0] ?? null;
      if (token) {
        take(target, token);
        return;
      }
      // A wrong, expired or mistyped code: Claude Code prints "OAuth error: …"
      // and waits on "Press Enter to retry". Its words end the sign-in now,
      // with Try again, instead of the 10-minute timeout.
      if (rejection) {
        deps.logger?.info?.("cloud.claude_code_rejected");
        end(target, "failed", rejection);
      }
    });
    pty.onExit(({ exitCode }) => {
      // Forget the process first, whatever the state: a later end() must never
      // kill a PID that is gone, which on Windows may already be another process.
      if (target.pty === pty) target.pty = null;
      if (record !== target || target.status.state !== "running") return;
      const last = CLAUDE_TOKEN_PATTERN.exec(cleanLoginOutput(target.rawOutput, target.submittedCodes))?.[0] ?? null;
      if (last) {
        take(target, last);
        return;
      }
      // Not Claude Code's last line: it can hold part of a token cut across lines.
      end(target, "failed", exitCode === 0
        ? "Claude Code finished without a token. Try again."
        : `Claude Code's sign-in stopped (exit code ${exitCode}).`);
    });
  }

  return {
    state(): CloudSignInStatus["claude"] {
      const current = record;
      return current
        ? {
          state: current.status.state,
          url: current.status.url,
          awaitingCode: current.status.awaitingCode,
          checkingCode: current.status.checkingCode === true,
          message: current.message,
          forEmail: current.options.forEmail?.trim() || null,
          foundEmail: current.foundEmail,
          check: current.check,
          renewKey: current.options.renewKey?.trim() || null,
          savedKey: current.savedKey,
          upload: current.upload,
        }
        : null;
    },
    /** Starts Claude Code's `setup-token`; a running one is replaced. */
    start(
      save: (token: string, outcome: ClaudePassSaveOutcome) => Promise<ClaudePassSaveResult>,
      options: ClaudeSignInStartOptions = {},
    ): void {
      const cliState = deps.resolveCli();
      if (cliState.kind === "blocked") throw new AdeExpectedError(cliState.message, "environment");
      if (live(record)) end(record, "cancelled");
      const target: SignInRecord = {
        status: { state: "running", output: "", url: null, awaitingCode: false },
        message: null,
        pty: null,
        rawOutput: "",
        submittedCodes: [],
        rawSinceSubmit: null,
        timeout: null,
        options,
        save,
        saving: null,
        verifyAbort: null,
        heldToken: null,
        foundEmail: null,
        check: null,
        savedKey: null,
        upload: null,
      };
      record = target;
      setTimer(target, LOGIN_TIMEOUT_MS, () => {
        if (record === target && (target.status.state === "running" || target.status.state === "verifying")) {
          end(target, "failed", "The sign-in timed out after 10 minutes.");
        }
      });
      if (cliState.kind === "ready") {
        spawn(target, cliState.cli);
        return;
      }
      // ADE's copy of Claude Code is still downloading: start once it lands.
      void cliState.done.then(
        (cli) => { if (record === target && target.status.state === "running") spawn(target, cli); },
        (error: unknown) => { if (record === target && live(target)) end(target, "failed", error instanceof Error ? error.message : String(error)); },
      );
    },
    submitCode(code: string): void {
      if (!record || record.status.state !== "running") throw new AdeExpectedError("This sign-in is not waiting for a code any more.", "user");
      writeLoginCode(record, code);
    },
    /** Keep B: saves the pass the check named for another account, labelled with that account. */
    keep(): void {
      const current = record;
      if (!current || current.status.state !== "mismatch" || !current.heldToken) {
        throw new AdeExpectedError("There is no pass waiting to be kept. Sign in again.", "user");
      }
      if (current.timeout) clearTimeout(current.timeout);
      current.timeout = null;
      saveAs(current, current.heldToken, { email: current.foundEmail, check: "kept_other", labelSource: "checked" });
    },
    /**
     * Stops a running sign-in (and drops a pass waiting in `mismatch`).
     * Settles once a token it already read is written, so a removal that
     * waits for it is the last word.
     */
    async cancel(): Promise<void> {
      const current = record;
      if (live(current)) end(current, "cancelled");
      record = null;
      await current?.saving;
    },
    dispose(options: { sync?: boolean } = {}): void {
      if (live(record)) end(record, "cancelled", null, options);
      record = null;
    },
  };
}

export type CloudClaudeSignIn = ReturnType<typeof createCloudClaudeSignIn>;
