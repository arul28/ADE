import {
  PROJECT_SECRET_ACTION_QUESTION_ID,
  PROJECT_SECRET_REASON_MAX_CHARS,
  PROJECT_SECRET_REQUEST_METADATA_KEY,
  PROJECT_SECRET_VALUE_QUESTION_ID,
  projectSecretNameError,
  type ProjectSecretRequestCard,
  type ProjectSecretRequestResult,
} from "../../../shared/projectSecretRequest";
import type { ProjectSecretSetArgs, ProjectSecretSummary, ProjectSecretsListResult } from "../../../shared/types/projectSecrets";

/** The default wait: long enough to go find a key in another tab, not forever. */
export const PROJECT_SECRET_REQUEST_DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const PROJECT_SECRET_REQUEST_MAX_TIMEOUT_MS = 2 * 60 * 60_000;

type RequestChatInput = (args: {
  chatSessionId: string;
  title: string;
  body: string;
  timeoutMs?: number;
  allowsFreeform?: boolean;
  providerMetadata?: Record<string, unknown>;
  eventDescription?: string;
  questions?: Array<{
    id?: string;
    header?: string;
    question: string;
    options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
    allowsFreeform?: boolean;
    isSecret?: boolean;
  }>;
  beforeAccept?: (answers: Record<string, string[]>) => void;
}) => Promise<{ decision: string; answers: Record<string, string[]>; responseText: string | null; timedOut?: boolean }>;

export type ProjectSecretRequestDeps = {
  requestChatInput: RequestChatInput;
  projectSecrets: {
    list(): ProjectSecretsListResult;
    set(args: ProjectSecretSetArgs): ProjectSecretSummary;
  };
};

function readArgs(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/**
 * `project_secret.request` — ask the person in this chat for a secret and
 * store it in the project's secrets.
 *
 * Blocks until the person answers, declines, or the wait runs out. The value
 * is the answer to an `isSecret` question: it reaches this function in memory,
 * goes straight to `projectSecrets.set`, and is dropped. It never lands on a
 * transcript event (the resolved event drops secret answers), never in a log
 * line here, and never in the result — the caller learns only the outcome.
 */
export async function requestProjectSecretFromUser(
  deps: ProjectSecretRequestDeps,
  rawArgs: unknown,
): Promise<ProjectSecretRequestResult> {
  const args = readArgs(rawArgs);
  const chatSessionId = typeof args.chatSessionId === "string" ? args.chatSessionId.trim() : "";
  if (!chatSessionId) {
    throw new Error("Asking for a secret needs a chat to ask in. Run `ade secrets request` from inside an ADE chat.");
  }
  const rawName = typeof args.name === "string" ? args.name.trim() : "";
  const nameError = projectSecretNameError(rawName);
  if (nameError) throw new Error(nameError);
  const name = rawName;
  const reason = (typeof args.reason === "string" ? args.reason.trim() : "").slice(0, PROJECT_SECRET_REASON_MAX_CHARS);
  if (!reason) {
    throw new Error("Say why you need the secret (--reason). The person decides from that one line.");
  }
  const generate = args.generate === true;
  const requestedTimeout = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
    ? Math.floor(args.timeoutMs)
    : PROJECT_SECRET_REQUEST_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requestedTimeout, 10_000), PROJECT_SECRET_REQUEST_MAX_TIMEOUT_MS);

  const exists = deps.projectSecrets.list().secrets.some((secret) => secret.name === name);
  const card: ProjectSecretRequestCard = { name, reason, generate, exists };

  // A client that draws the native card reads the metadata; any other client
  // (an older desktop, the phone, the TUI) still gets a working password
  // question, with a keep/replace pick first when the name already exists.
  const questions = [
    ...(exists
      ? [{
          id: PROJECT_SECRET_ACTION_QUESTION_ID,
          header: name,
          question: `${name} already has a value in this project.`,
          allowsFreeform: false,
          options: [
            { label: "Keep existing", value: "keep", recommended: true },
            { label: "Replace", value: "replace" },
          ],
        }]
      : []),
    {
      id: PROJECT_SECRET_VALUE_QUESTION_ID,
      header: name,
      question: reason,
      allowsFreeform: true,
      isSecret: true,
    },
  ];

  // The save happens while the user's answer is being accepted, before the
  // card resolves: if it fails, the card stays open with the error instead of
  // showing a "saved" receipt for a secret that was not stored.
  let saved = false;
  let replaced = false;
  const beforeAccept = (answers: Record<string, string[]>): void => {
    const action = answers[PROJECT_SECRET_ACTION_QUESTION_ID]?.[0] ?? null;
    const value = answers[PROJECT_SECRET_VALUE_QUESTION_ID]?.[0] ?? "";
    if (!value || (exists && action === "keep")) return;
    try {
      deps.projectSecrets.set({ name, value });
    } catch (error) {
      // The service's own messages never carry the value.
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new Error(`ADE could not save ${name}: ${detail}`);
    }
    saved = true;
    replaced = exists;
  };

  const response = await deps.requestChatInput({
    beforeAccept,
    chatSessionId,
    title: `Secret needed: ${name}`,
    body: reason,
    timeoutMs,
    allowsFreeform: true,
    eventDescription: `Secret needed: ${name}`,
    providerMetadata: { [PROJECT_SECRET_REQUEST_METADATA_KEY]: card },
    questions,
  });

  if (response.timedOut) {
    throw new Error(`Nobody answered the request for ${name} in time. Ask again when the person is around.`);
  }
  if (response.decision === "decline" || response.decision === "cancel" || response.decision === "none") {
    return { name, saved: false, declined: true };
  }
  if (saved) return { name, saved: true, replaced };
  return exists ? { name, saved: false, kept: true } : { name, saved: false, declined: true };
}
