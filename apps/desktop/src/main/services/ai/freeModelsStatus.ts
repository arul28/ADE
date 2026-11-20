import fs from "node:fs";
import { readToolUsage, toolUsageRootFor } from "../../../../../ade-cli/src/services/tools/usage";
import { getFreeModelDefaultIds } from "../../../shared/freeModels";
import type {
  AiClaudeAvailability,
  AiFreeModelsStatus,
  AiProviderConnectionStatus,
  OpenCodeProviderSummary,
} from "../../../shared/types";
import { resolveAdeCacheFile } from "../shared/adeCacheFile";
import { writeTextAtomic } from "../shared/utils";
import type { DetectedAuth } from "./authDetector";

/**
 * The free-models block of the AI status (`shared/freeModels.ts`), built by
 * the machine that answers the status, so the desktop, the web client and
 * the phone all read one answer for the chat's own machine.
 */

/** Written once, the first time this machine sees any provider signed in. */
const SIGN_IN_HISTORY_FILE = "provider-sign-in-history.json";

/**
 * Tools whose use says nothing about a sign-in: OpenCode runs the free models
 * themselves, and Node only runs Pi's terminal.
 */
const TOOLS_THAT_ARE_NOT_A_SIGN_IN = new Set(["opencode", "node"]);

export type FreeModelsStatusInputs = {
  claude: AiClaudeAvailability;
  providerConnections: Record<string, AiProviderConnectionStatus | null | undefined>;
  auth: readonly DetectedAuth[];
  /** Models Pi can run with its own sign-ins. */
  piAvailableModelIds: readonly string[];
  opencodeProviders: readonly OpenCodeProviderSummary[];
  /** Local models a runtime on this machine has loaded. */
  localModelCount: number;
  customProviderCount: number;
};

/**
 * True when something other than a free model can chat here: a provider
 * signed in, an API key, a custom provider, or a loaded local model.
 */
export function machineHasNonFreeChat(inputs: FreeModelsStatusInputs): boolean {
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
  return inputs.localModelCount > 0 || inputs.customProviderCount > 0;
}

function signInHistoryPath(): string {
  return resolveAdeCacheFile(SIGN_IN_HISTORY_FILE);
}

function agentRanHere(env: NodeJS.ProcessEnv): boolean {
  try {
    const usage = readToolUsage(toolUsageRootFor({ env }));
    return Object.keys(usage).some((tool) => !TOOLS_THAT_ARE_NOT_A_SIGN_IN.has(tool));
  } catch {
    return false;
  }
}

/** Read once per process after it turns true: the answer never goes back. */
let signInSeenCache = false;

/**
 * Whether this machine has ever had a provider signed in. Records the first
 * sign-in it sees, so signing out later does not make a person "new" again.
 * An agent that ran here before this record existed counts too.
 */
export function providerSignInSeen(signedInNow: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (signInSeenCache) return true;
  const file = signInHistoryPath();
  let seen = false;
  try {
    seen = fs.existsSync(file);
  } catch {
    seen = false;
  }
  if (!seen && signedInNow) {
    try {
      writeTextAtomic(file, `${JSON.stringify({ firstSeenAt: new Date().toISOString() })}\n`);
    } catch {
      // A machine that cannot write keeps answering from the live state.
    }
    seen = true;
  }
  if (!seen) seen = agentRanHere(env);
  if (seen) signInSeenCache = true;
  return seen;
}

export function buildFreeModelsStatus(inputs: FreeModelsStatusInputs, env: NodeJS.ProcessEnv = process.env): AiFreeModelsStatus {
  const signedIn = machineHasNonFreeChat(inputs);
  return {
    nothingSignedIn: !signedIn,
    everSignedIn: providerSignInSeen(signedIn, env),
    preferredDefaultModelIds: getFreeModelDefaultIds(),
  };
}
