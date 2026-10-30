import {
  PROJECT_SECRET_ACTION_QUESTION_ID,
  PROJECT_SECRET_DELIVERY_OPTIONS,
  PROJECT_SECRET_DELIVERY_QUESTION_ID,
  PROJECT_SECRET_REASON_MAX_CHARS,
  PROJECT_SECRET_REQUEST_METADATA_KEY,
  PROJECT_SECRET_VALUE_QUESTION_ID,
  projectSecretNameError,
  readProjectSecretDelivery,
  type ProjectSecretDelivery,
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
  /**
   * Temporary private files (`secretTempFiles.ts`) on the machine that runs the
   * chat. Absent: the card offers only the project's secrets.
   */
  secretFiles?: {
    write(input: { chatSessionId: string; requestId: string | null; name: string; value: string; ttlMs: number | null }): {
      path: string;
      expiresAt: string;
    };
    find(input: { chatSessionId: string; requestId: string }): { path: string; expiresAt: string } | null;
  } | null;
};

/** A retry key is the agent's own label for one ask: short and printable. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Asks still waiting on the person, by chat and retry key, so an agent that
 * re-runs the command while the card is open joins the same card instead of
 * raising a second one.
 */
const inFlightByRequestId = new Map<string, Promise<ProjectSecretRequestResult>>();

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
  const rawRequestId = typeof args.requestId === "string" ? args.requestId.trim() : "";
  if (rawRequestId && !REQUEST_ID_PATTERN.test(rawRequestId)) {
    throw new Error("--request-id may use letters, numbers, '.', '_', ':' and '-' (max 128 characters).");
  }
  const requestId = rawRequestId || null;
  if (requestId) {
    // A retry of an ask already answered with a file gets that same file:
    // the person is not asked twice, and the card that answered cannot be
    // re-used to send the value anywhere else.
    const earlier = deps.secretFiles?.find({ chatSessionId, requestId }) ?? null;
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (earlier) {
      return { name, saved: true, delivery: "file", file: earlier.path, expiresAt: earlier.expiresAt, reused: true };
    }
    const key = `${chatSessionId}\u0000${requestId}`;
    const pending = inFlightByRequestId.get(key);
    if (pending) return await pending;
    const ask = askProjectSecret(deps, args, chatSessionId, requestId);
    inFlightByRequestId.set(key, ask);
    try {
      return await ask;
    } finally {
      if (inFlightByRequestId.get(key) === ask) inFlightByRequestId.delete(key);
    }
  }
  return await askProjectSecret(deps, args, chatSessionId, null);
}

async function askProjectSecret(
  deps: ProjectSecretRequestDeps,
  args: Record<string, unknown>,
  chatSessionId: string,
  requestId: string | null,
): Promise<ProjectSecretRequestResult> {
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

  const askedDelivery = args.delivery == null ? "secrets" : readProjectSecretDelivery(args.delivery);
  if (!askedDelivery) throw new Error("--delivery must be `secrets` or `file`.");
  const secretFiles = deps.secretFiles ?? null;
  if (askedDelivery === "file" && !secretFiles) {
    throw new Error("This ADE runtime cannot write temporary secret files. Ask without --delivery file.");
  }
  const delivery: ProjectSecretDelivery = askedDelivery;
  const ttlMs = typeof args.ttlMs === "number" && Number.isFinite(args.ttlMs) ? Math.floor(args.ttlMs) : null;

  const exists = deps.projectSecrets.list().secrets.some((secret) => secret.name === name);
  const card: ProjectSecretRequestCard = { name, reason, generate, exists, delivery };

  // A client that draws the native card reads the metadata; any other client
  // (an older desktop, the phone) still gets a working password
  // question, with a keep/replace pick first when the name already exists.
  //
  // The delivery pick is always there (when this runtime can write files), so
  // every client lets the person choose, with the agent's ask as the default.
  const questions = [
    ...(secretFiles
      ? [{
          id: PROJECT_SECRET_DELIVERY_QUESTION_ID,
          header: name,
          question: `Where should ADE keep ${name}?`,
          allowsFreeform: false,
          options: PROJECT_SECRET_DELIVERY_OPTIONS.map((option) => ({
            label: option.label,
            value: option.value,
            description: option.description,
            recommended: option.value === delivery,
          })),
        }]
      : []),
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
  let fileResult: { path: string; expiresAt: string } | null = null;
  const beforeAccept = (answers: Record<string, string[]>): void => {
    const action = answers[PROJECT_SECRET_ACTION_QUESTION_ID]?.[0] ?? null;
    const value = answers[PROJECT_SECRET_VALUE_QUESTION_ID]?.[0] ?? "";
    // A client that sends no pick (an older desktop's native card) gets what
    // the agent asked for: a file request never lands in the project's secrets.
    const chosen = readProjectSecretDelivery(answers[PROJECT_SECRET_DELIVERY_QUESTION_ID]?.[0]) ?? delivery;
    if (chosen === "file" && secretFiles) {
      // An existing project secret is not touched; keep/replace does not apply.
      if (!value) return;
      try {
        fileResult = secretFiles.write({ chatSessionId, requestId, name, value, ttlMs });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        throw new Error(`ADE could not write the private file for ${name}: ${detail}`);
      }
      saved = true;
      return;
    }
    // An existing value is replaced only on an explicit "replace"; an answer
    // that skips the pick keeps it.
    if (!value || (exists && action !== "replace")) return;
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
  const file = fileResult as { path: string; expiresAt: string } | null;
  if (saved && file) {
    return { name, saved: true, delivery: "file", file: file.path, expiresAt: file.expiresAt };
  }
  if (saved) return { name, saved: true, replaced };
  return exists ? { name, saved: false, kept: true } : { name, saved: false, declined: true };
}
