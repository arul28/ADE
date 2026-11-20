import fs from "node:fs";
import { readToolUsage, toolUsageRootFor } from "../../../../../ade-cli/src/services/tools/usage";
import { getFreeModelDefaultIds } from "../../../shared/freeModels";
import type {
  AiClaudeAvailability,
  AiFreeModelsStatus,
  AiProviderConnections,
  OpenCodeProviderSummary,
} from "../../../shared/types";
import { captureError } from "../../../shared/sentry/capture";
import { resolveAdeCacheFile } from "../shared/adeCacheFile";
import { NON_AGENT_TOOLS } from "../tools/agentToolDemand";
import { writeTextAtomic } from "../shared/utils";
import type { DetectedAuth } from "./authDetector";

/**
 * The free-models block of the AI status (`shared/freeModels.ts`), built by
 * the machine that answers the status, so the desktop, the web client and
 * the phone all read one answer for the chat's own machine.
 */

/** Written at the first check, then once more at the first sign-in seen. */
const SIGN_IN_HISTORY_FILE = "provider-sign-in-history.json";

export type FreeModelsStatusInputs = {
  claude: AiClaudeAvailability;
  providerConnections: AiProviderConnections;
  auth: readonly DetectedAuth[];
  /** Models Pi can run with its own sign-ins. */
  piAvailableModelIds: readonly string[];
  opencodeProviders: readonly OpenCodeProviderSummary[];
  /** Local models a runtime on this machine has loaded. */
  localModelCount: number;
  customProviderCount: number;
};

/**
 * True when a provider is signed in here: a provider login, an API key, Pi's
 * own sign-ins, an OpenCode key or a custom provider.
 */
function machineHasSignIn(inputs: FreeModelsStatusInputs): boolean {
  if (inputs.claude.auth.ready) return true;
  if (Object.values(inputs.providerConnections).some((connection) => connection?.authAvailable === true)) return true;
  if (inputs.auth.some((entry) => (
    entry.type === "api-key"
    || entry.type === "openrouter"
    || (entry.type === "cli-subscription" && entry.authenticated)
  ))) return true;
  if (inputs.piAvailableModelIds.length > 0) return true;
  // `connected` alone is Zen's free tier; `signedIn` is a key or a login.
  if (inputs.opencodeProviders.some((provider) => provider.signedIn === true)) return true;
  return inputs.customProviderCount > 0;
}

/**
 * Each failure is reported once per process: a cache folder that cannot be
 * read or written stays so, and the status is built often.
 */
const reportedFailures = new Set<string>();

function reportOnce(kind: string, error: unknown): void {
  if (reportedFailures.has(kind)) return;
  reportedFailures.add(kind);
  captureError(error, { level: "warning", fingerprint: ["free-models", kind] });
}

function agentRanHere(env: NodeJS.ProcessEnv): boolean {
  try {
    const usage = readToolUsage(toolUsageRootFor({ env }));
    return Object.keys(usage).some((tool) => !NON_AGENT_TOOLS.has(tool));
  } catch (error) {
    reportOnce("tool-usage-read", error);
    return false;
  }
}

/**
 * The record file: `firstSeenAt` once a sign-in was seen. A file without it
 * means this machine was checked and nobody had signed in yet.
 */
type SignInHistory = { firstSeenAt?: string; checkedAt?: string };

/** The record; null when there is none yet; "unreadable" for any other read failure. */
function readSignInHistory(file: string): SignInHistory | null | "unreadable" {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    reportOnce("sign-in-history-read", error);
    return "unreadable";
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as SignInHistory : {};
  } catch (error) {
    // A damaged record still says the machine was checked.
    reportOnce("sign-in-history-parse", error);
    return {};
  }
}

function writeSignInHistory(file: string, history: SignInHistory): void {
  try {
    writeTextAtomic(file, `${JSON.stringify(history)}\n`);
  } catch (error) {
    // A machine that cannot write keeps answering from the live state.
    reportOnce("sign-in-history-write", error);
  }
}

/** Read once per process after it turns true: the answer never goes back. */
let signInSeenCache = false;

/**
 * Whether this machine has ever had a provider signed in. Records the first
 * sign-in it sees, so signing out later does not make a person "new" again.
 *
 * The first check on a machine with no record also counts an agent that ran
 * here before (ADE versions older than the record), and saves the answer.
 * Later agent runs do not count: a runtime start is noted even when the
 * person never signed in, and must not hide the free models from them.
 */
export function providerSignInSeen(signedInNow: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (signInSeenCache) return true;
  const file = resolveAdeCacheFile(SIGN_IN_HISTORY_FILE);
  const history = readSignInHistory(file);
  const now = new Date().toISOString();
  let seen: boolean;
  if (history === "unreadable") {
    // Never overwrite a record that may hold a sign-in: answer from now.
    seen = signedInNow;
  } else if (history?.firstSeenAt) {
    seen = true;
  } else if (history) {
    seen = signedInNow;
    if (seen) writeSignInHistory(file, { ...history, firstSeenAt: now });
  } else {
    seen = signedInNow || agentRanHere(env);
    writeSignInHistory(file, seen ? { checkedAt: now, firstSeenAt: now } : { checkedAt: now });
  }
  if (seen) signInSeenCache = true;
  return seen;
}

export function buildFreeModelsStatus(inputs: FreeModelsStatusInputs, env: NodeJS.ProcessEnv = process.env): AiFreeModelsStatus {
  const signedIn = machineHasSignIn(inputs);
  return {
    // A loaded local model can chat too, but it is not a sign-in: it does not
    // make this person "not new".
    nothingSignedIn: !signedIn && inputs.localModelCount === 0,
    everSignedIn: providerSignInSeen(signedIn, env),
    preferredDefaultModelIds: getFreeModelDefaultIds(),
  };
}
