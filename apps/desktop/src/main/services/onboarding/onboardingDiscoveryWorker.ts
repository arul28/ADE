import {
  isExternalSessionProvider,
  type OnboardingProjectCandidate,
  type OnboardingProjectChat,
} from "../../../shared/types";
import {
  createOnboardingChatCache,
  discoverOnboardingProjectCandidates,
  readOnboardingProjectChatsInto,
  type DiscoveryLogger,
  type OnboardingChatCache,
  type OnboardingChatList,
} from "./onboardingProjectDiscovery";

/**
 * One first-run discovery request and its answer, as they cross from the main
 * process to the child that does the reading (`onboardingDiscoveryClient.ts`)
 * and back. The child keeps nothing between requests: the chat lists it read
 * come back in `cache`, and a chat-list request carries discovery's read of
 * the other providers in.
 */
export type OnboardingDiscoveryRequest =
  | { kind: "discover"; knownRoots: string[]; now: number }
  | { kind: "listChats"; rootPath: string; now: number; otherProviderChats: OnboardingChatList | null };

export type OnboardingDiscoveryLogLine = {
  level: "warn" | "info";
  message: string;
  fields?: Record<string, unknown>;
};

export type OnboardingDiscoveryResponse =
  | {
    ok: true;
    kind: "discover";
    projects: OnboardingProjectCandidate[];
    cache: OnboardingChatCache;
    logs: OnboardingDiscoveryLogLine[];
  }
  | {
    ok: true;
    kind: "listChats";
    chats: OnboardingProjectChat[];
    /** Only this project's list, never the machine-wide one the request carried. */
    projectChatLists: OnboardingChatCache["projectChatLists"];
    logs: OnboardingDiscoveryLogLine[];
  }
  | { ok: false; error: string; logs: OnboardingDiscoveryLogLine[] };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isChat(value: unknown): value is OnboardingProjectChat {
  return isObject(value)
    && typeof value.id === "string"
    && isExternalSessionProvider(value.provider)
    && isNullableString(value.title)
    && isNullableString(value.cwd)
    && typeof value.lastActiveAt === "number"
    && isNullableNumber(value.messageCount);
}

function isProject(value: unknown): value is OnboardingProjectCandidate {
  return isObject(value)
    && typeof value.rootPath === "string"
    && typeof value.name === "string"
    && isNullableString(value.repoLabel)
    && typeof value.chatCount === "number"
    && typeof value.recentChatCount === "number"
    && isNullableNumber(value.lastActiveAt)
    && Array.isArray(value.providers) && value.providers.every(isExternalSessionProvider)
    && typeof value.laneCount === "number"
    && typeof value.suggested === "boolean"
    && typeof value.inAde === "boolean";
}

function isChatList(value: unknown): value is OnboardingChatList {
  return isObject(value)
    && typeof value.at === "number"
    && Array.isArray(value.chats) && value.chats.every(isChat)
    && (value.missing === undefined
      || (Array.isArray(value.missing) && value.missing.every(isExternalSessionProvider)));
}

function isChatCache(value: unknown): value is OnboardingChatCache {
  return isObject(value)
    && (value.otherProviderChats === null || isChatList(value.otherProviderChats))
    && isObject(value.projectChatLists)
    && Object.values(value.projectChatLists).every(isChatList);
}

function isLogLine(value: unknown): value is OnboardingDiscoveryLogLine {
  return isObject(value)
    && (value.level === "warn" || value.level === "info")
    && typeof value.message === "string"
    && (value.fields === undefined || isObject(value.fields));
}

/** A child's parsed answer, checked against the response shape; null when it is anything else. */
export function parseOnboardingDiscoveryResponse(value: unknown): OnboardingDiscoveryResponse | null {
  if (!isObject(value) || !Array.isArray(value.logs) || !value.logs.every(isLogLine)) return null;
  if (value.ok === false) return typeof value.error === "string" ? (value as OnboardingDiscoveryResponse) : null;
  if (value.ok !== true || !isChatCache(value.cache)) return null;
  if (value.kind === "discover") {
    return Array.isArray(value.projects) && value.projects.every(isProject) ? (value as OnboardingDiscoveryResponse) : null;
  }
  if (value.kind === "listChats") {
    return Array.isArray(value.chats) && value.chats.every(isChat)
      && isObject(value.projectChatLists) && Object.values(value.projectChatLists).every(isChatList)
      ? (value as OnboardingDiscoveryResponse)
      : null;
  }
  return null;
}

function parseOnboardingDiscoveryRequest(value: unknown): OnboardingDiscoveryRequest {
  if (isObject(value) && typeof value.now === "number") {
    if (value.kind === "discover" && Array.isArray(value.knownRoots) && value.knownRoots.every((root) => typeof root === "string")) {
      return { kind: "discover", knownRoots: value.knownRoots, now: value.now };
    }
    if (
      value.kind === "listChats"
      && typeof value.rootPath === "string"
      && (value.otherProviderChats === null || isChatList(value.otherProviderChats))
    ) {
      return { kind: "listChats", rootPath: value.rootPath, now: value.now, otherProviderChats: value.otherProviderChats };
    }
  }
  throw new Error("malformed discovery request");
}

/** Bounds what a misbehaving provider can make the child send back as log lines. */
const MAX_LOG_LINES = 200;

function collectingLogger(logs: OnboardingDiscoveryLogLine[]): DiscoveryLogger {
  const push = (level: OnboardingDiscoveryLogLine["level"]) => (message: string, fields?: Record<string, unknown>) => {
    if (logs.length < MAX_LOG_LINES) logs.push({ level, message, ...(fields ? { fields } : {}) });
  };
  return { warn: push("warn"), info: push("info") };
}

/** Answers one request. The child runs it; the main process runs it itself only when the child cannot start. */
export async function runOnboardingDiscoveryRequest(request: OnboardingDiscoveryRequest): Promise<OnboardingDiscoveryResponse> {
  const logs: OnboardingDiscoveryLogLine[] = [];
  const logger = collectingLogger(logs);
  const cache = createOnboardingChatCache();
  try {
    if (request.kind === "discover") {
      const projects = await discoverOnboardingProjectCandidates({
        knownRoots: request.knownRoots,
        cache,
        logger,
        now: request.now,
      });
      return { ok: true, kind: "discover", projects, cache, logs };
    }
    cache.otherProviderChats = request.otherProviderChats;
    const chats = await readOnboardingProjectChatsInto({ rootPath: request.rootPath, cache, logger, now: request.now });
    return { ok: true, kind: "listChats", chats, projectChatLists: cache.projectChatLists, logs };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), logs };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The child's whole life: one request on stdin, one JSON answer on stdout. */
export async function runOnboardingDiscoveryWorkerEntrypoint(): Promise<number> {
  let response: OnboardingDiscoveryResponse;
  try {
    response = await runOnboardingDiscoveryRequest(parseOnboardingDiscoveryRequest(JSON.parse(await readStdin())));
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error), logs: [] };
  }
  await new Promise<void>((resolve) => process.stdout.write(JSON.stringify(response), () => resolve()));
  return response.ok ? 0 : 1;
}
