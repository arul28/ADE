/**
 * Sign-in for the agent CLIs ADE runs from its own pinned copy (Grok, Devin,
 * Muse, GitHub Copilot, Droid, Kimi), the way Claude Code and Codex sign in:
 * the CLI's own login runs in a private PTY on the machine that owns it, its
 * output is read for the sign-in link, a device code and a "paste the code"
 * prompt, and the result is the provider's saved login read back, never the
 * CLI's text. ADE never sees or stores a token; the CLI writes its own.
 *
 * `ai.cliLoginStart` / `cliLoginStatus` / `cliLoginSubmitCode` /
 * `cliLoginCancel`, routed to the owning machine like the other `ai` sign-ins.
 */
import type { ProviderLoginState } from "./providerInstances";

export const AGENT_CLI_LOGIN_PROVIDERS = ["grok", "devin", "muse", "copilot", "droid", "kimi"] as const;

export type AgentCliLoginProvider = (typeof AGENT_CLI_LOGIN_PROVIDERS)[number];

export function isAgentCliLoginProvider(value: unknown): value is AgentCliLoginProvider {
  return typeof value === "string" && (AGENT_CLI_LOGIN_PROVIDERS as readonly string[]).includes(value);
}

/** Kimi signs in to kimi.ai (`global`) or kimi.com (`mainland-cn`). */
export type KimiLoginRegion = "global" | "mainland-cn";

export type AgentCliLoginStartArgs = {
  provider: AgentCliLoginProvider;
  /** Kimi only; `global` when left out. */
  kimiRegion?: KimiLoginRegion;
};

export type AgentCliLoginRefArgs = { loginId: string };

export type AgentCliLoginSubmitCodeArgs = { loginId: string; code: string };

/** One CLI's saved login as its machine reads it from disk; ADE never reads the token. */
export type AgentCliSavedLogin = {
  /** The login the CLI saves is on disk, read the way detection reads it. */
  signedIn: boolean;
  /**
   * When and how big each file of that login is (or that it is missing). A
   * sign-in that just finished changes it; the same value means the login on
   * disk is the one that was there before.
   */
  fingerprint: string;
  /** The account the saved login names, when it names one (Copilot's GitHub login). */
  account?: string;
};

export type AgentCliLoginStatus = {
  loginId: string;
  provider: AgentCliLoginProvider;
  state: ProviderLoginState;
  /** The sign-in link the CLI printed, once it has. */
  url: string | null;
  /** A device sign-in's one-time code, typed or confirmed on the sign-in page. */
  deviceCode?: string;
  /** The CLI is asking for a code pasted from the browser (Devin). */
  awaitingCode: boolean;
  /**
   * The CLI opens the sign-in page in a browser on its own machine (Grok,
   * Muse, Droid try to). A sheet on that machine does not open it again.
   */
  opensBrowser: boolean;
  /** Set while ADE first downloads its copy of the CLI; null once it runs. */
  downloading: string | null;
  /** The CLI's output so far, without terminal escapes; the last few KB. */
  output: string;
  /** The signed-in account, when the CLI or the saved login names it. */
  email?: string;
  /** Why a failed sign-in failed, in one sentence. */
  message?: string;
  startedAt: string;
  endedAt?: string;
};
