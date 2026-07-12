import { probeCodexRolloutFile } from "../externalSessions/discoverCodex";
import type { AgentChatResumeFailureKind } from "../../../shared/types/chat";

export type ResumeFailureKind = AgentChatResumeFailureKind;

export type ResumeFailureClassification = {
  kind: ResumeFailureKind;
  rolloutFileFound: boolean | null;
  detail: string;
};

const MAX_DETAIL_CHARS = 2_000;

function boundedErrorDetail(error: unknown): string {
  let detail: string;
  if (error instanceof Error) {
    detail = error.message || error.name;
  } else if (typeof error === "string") {
    detail = error;
  } else {
    try {
      detail = JSON.stringify(error);
    } catch {
      detail = String(error);
    }
  }
  const normalized = detail.trim() || "Unknown resume failure.";
  return normalized.length <= MAX_DETAIL_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_DETAIL_CHARS - 3)}...`;
}

export function classifyCodexResumeFailure(
  error: unknown,
  threadId: string,
  opts: { codexHome?: string } = {},
): ResumeFailureClassification {
  const rolloutFileFound = probeCodexRolloutFile(threadId, opts);
  const detail = boundedErrorDetail(error);
  const text = detail.toLowerCase();

  const providerEnvironment = /\bmcp\b/u.test(text)
    || /\bserver\b[^\n]{0,120}\b(?:failed|timed out)\b/u.test(text)
    || /\b(?:tool|plugin)\b[^\n]{0,120}\b(?:start|startup|initialize|initialization)\b[^\n]{0,80}\b(?:failed|timed out|error)\b/u.test(text);
  if (providerEnvironment) {
    return { kind: "provider_environment", rolloutFileFound, detail };
  }

  const transient = /\b(?:timeout|timed out|connection|socket|transport|econn[a-z0-9_]*)\b/u.test(text)
    || /app[- ]server[^\n]{0,80}(?:not running|not ready|unavailable)/u.test(text);
  if (transient) {
    return { kind: "transient", rolloutFileFound, detail };
  }

  const threadMissing = /\b(?:no thread|thread not found|unknown thread|not found)\b/u.test(text);
  if (threadMissing && rolloutFileFound !== true) {
    return { kind: "thread_missing", rolloutFileFound, detail };
  }

  return { kind: "unknown", rolloutFileFound, detail };
}
