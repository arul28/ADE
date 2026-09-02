/**
 * Cursor SDK `run.conversation()` returns `ConversationTurn[]`:
 *   { type: "agentConversationTurn", turn: { userMessage?, steps } }
 *   { type: "shellConversationTurn", turn: { shellCommand?, shellOutput? } }
 * ADE also sees wrapped RPC payloads (`{ turns }`, `{ result }`) and older
 * flattened `{ type: "agent" | "shell" }` shapes, so unwrap is tolerant.
 */

export const CURSOR_CLOUD_CONVERSATION_RETRY_ATTEMPTS = 8;
export const CURSOR_CLOUD_CONVERSATION_RETRY_MS = 2_000;

/**
 * How often a watched cloud chat re-reads its agent's remote name.
 *
 * Cursor owns that name, but the mirror ticks every three seconds during an
 * active run and a rename on cursor.com is not worth an API call per tick.
 */
export const CURSOR_CLOUD_REMOTE_NAME_READ_TTL_MS = 60_000;

/**
 * How many times a terminal run may read back an empty conversation before ADE
 * stops asking.
 *
 * A run that ends in ERROR with no visible turns never produces one, so an
 * unbounded retry refetches it on every mirror tick for the life of the
 * session. A few attempts still cover the real case the retry exists for: a run
 * that reports terminal before its VM has written the transcript.
 */
export const CURSOR_CLOUD_EMPTY_TERMINAL_READ_LIMIT = 3;

/**
 * How many event-driven name reads a still-unnamed cloud chat may make on top
 * of the TTL rule.
 *
 * Cursor names an agent shortly after its first run produces output, which is
 * usually after ADE's first read. Rather than poll, the mirror re-reads the name
 * only while the ADE title is still a default and only when a tick yields the
 * first visible turn or a run reaches a terminal status, and stops after this
 * many extra reads.
 */
export const CURSOR_CLOUD_PLACEHOLDER_NAME_READ_LIMIT = 3;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const WRAPPED_TURN_KEYS = [
  "turns",
  "messages",
  "conversation",
  "content",
  "items",
  "result",
] as const;

const LONE_TURN_TYPES = new Set([
  "agent",
  "shell",
  "agentConversationTurn",
  "shellConversationTurn",
]);

export type UnwrappedCloudAgentTurn = {
  kind: "agent";
  userText: string;
  steps: unknown[];
};

export type UnwrappedCloudShellTurn = {
  kind: "shell";
  command: string;
  cwd: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type UnwrappedCloudConversationTurn =
  | UnwrappedCloudAgentTurn
  | UnwrappedCloudShellTurn;

export function readCloudTextField(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  return typeof record?.text === "string" ? record.text.trim() : "";
}

export function flattenCloudConversationMessages(conversation: unknown): unknown[] {
  if (!conversation) return [];
  if (Array.isArray(conversation)) return conversation;
  const record = asRecord(conversation);
  if (!record) return [];
  if (typeof record.type === "string" && LONE_TURN_TYPES.has(record.type)) {
    return [conversation];
  }
  for (const key of WRAPPED_TURN_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (!nested) continue;
    for (const innerKey of WRAPPED_TURN_KEYS) {
      const inner = nested[innerKey];
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

export function cloudTurnFingerprint(turn: UnwrappedCloudConversationTurn): string | null {
  if (turn.kind === "shell") return turn.command ? `shell:${turn.command}` : null;
  if (turn.userText) return `user:${turn.userText}`;
  for (const rawStep of turn.steps) {
    const step = asRecord(rawStep);
    if (!step) continue;
    const stepType = typeof step.type === "string" ? step.type : "";
    if (stepType !== "assistantMessage") continue;
    const text = readCloudTextField(step.message);
    if (text) return `text:${text}`;
  }
  return null;
}

export function transcriptCloudFingerprints(
  events: Array<{ event: { type: string; text?: string; command?: string } }>,
): Set<string> {
  const fingerprints = new Set<string>();
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "user_message" && event.text?.trim()) {
      fingerprints.add(`user:${event.text.trim()}`);
    } else if (event.type === "text" && event.text?.trim()) {
      fingerprints.add(`text:${event.text.trim()}`);
    } else if (event.type === "command" && event.command?.trim()) {
      fingerprints.add(`shell:${event.command.trim()}`);
    }
  }
  return fingerprints;
}

export function fingerprintAlreadyHydrated(fingerprints: Set<string>, candidate: string): boolean {
  if (fingerprints.has(candidate)) return true;
  const [kind, ...rest] = candidate.split(":");
  const value = rest.join(":");
  if (!value) return false;
  for (const existing of fingerprints) {
    if (!existing.startsWith(`${kind}:`)) continue;
    const known = existing.slice(kind.length + 1);
    if (value === known || value.endsWith(known) || known.endsWith(value)) return true;
  }
  return false;
}

export function unwrapCloudConversationTurn(raw: unknown): UnwrappedCloudConversationTurn | null {
  const wrapper = asRecord(raw);
  if (!wrapper) return null;
  const type = typeof wrapper.type === "string" ? wrapper.type : "";
  const payload = asRecord(wrapper.turn) ?? wrapper;

  if (type === "shellConversationTurn" || type === "shell") {
    const commandRecord = asRecord(payload.shellCommand) ?? asRecord(payload.command) ?? payload;
    const outputRecord = asRecord(payload.shellOutput) ?? asRecord(payload.output);
    const command = typeof commandRecord.command === "string" ? commandRecord.command.trim() : "";
    if (!command) return null;
    const cwd = typeof commandRecord.workingDirectory === "string"
      ? commandRecord.workingDirectory
      : null;
    return {
      kind: "shell",
      command,
      cwd,
      stdout: typeof outputRecord?.stdout === "string" ? outputRecord.stdout : "",
      stderr: typeof outputRecord?.stderr === "string" ? outputRecord.stderr : "",
      exitCode: typeof outputRecord?.exitCode === "number" ? outputRecord.exitCode : null,
    };
  }

  if (
    type === "agentConversationTurn"
    || type === "agent"
    || Array.isArray(payload.steps)
    || payload.userMessage != null
  ) {
    return {
      kind: "agent",
      userText: readCloudTextField(payload.userMessage),
      steps: Array.isArray(payload.steps) ? payload.steps : [],
    };
  }
  return null;
}

function stepHasVisibleContent(rawStep: unknown): boolean {
  const step = asRecord(rawStep);
  if (!step) return false;
  const stepType = typeof step.type === "string" ? step.type : "";
  if (
    stepType === "assistantMessage"
    || stepType === "thinkingMessage"
    || stepType === "thinking"
  ) {
    return Boolean(readCloudTextField(step.message));
  }
  return stepType === "toolCall";
}

export type CloudRunListItem = {
  runId: string;
  status: string;
  modelSdkId: string | null;
};

function parseCloudRunRecord(raw: unknown): CloudRunListItem | null {
  const record = asRecord(raw);
  if (!record) return null;
  const runId = typeof record.runId === "string" && record.runId.trim()
    ? record.runId.trim()
    : typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : "";
  if (!runId) return null;
  const model = asRecord(record.model);
  return {
    runId,
    status: typeof record.status === "string" ? record.status : "",
    modelSdkId:
      (typeof model?.id === "string" && model.id.trim())
        ? model.id.trim()
        : (typeof record.modelId === "string" && record.modelId.trim())
          ? record.modelId.trim()
          : null,
  };
}

export function cloudRunsFromList(runs: unknown): CloudRunListItem[] {
  const record = asRecord(runs);
  const items = Array.isArray(runs)
    ? runs
    : Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.runs)
        ? record.runs
        : [];
  const parsed: CloudRunListItem[] = [];
  for (const item of items) {
    const run = parseCloudRunRecord(item);
    if (run) parsed.push(run);
  }
  return parsed;
}

export function latestCloudRunFromList(runs: unknown): CloudRunListItem | null {
  return cloudRunsFromList(runs)[0] ?? null;
}

export function cloudConversationHasTurns(conversation: unknown): boolean {
  return flattenCloudConversationMessages(conversation).some((raw) => {
    const turn = unwrapCloudConversationTurn(raw);
    if (!turn) return false;
    if (turn.kind === "shell") return Boolean(turn.command);
    return Boolean(turn.userText) || turn.steps.some(stepHasVisibleContent);
  });
}

export function isCloudRunStillLive(status: string | null | undefined): boolean {
  if (!status) return false;
  const lower = status.toLowerCase();
  return lower === "creating" || lower === "running" || lower === "queued";
}

/**
 * Presence-gated inbound sync backoff. Cursor Cloud has no webhook on create,
 * so ADE polls `Agent.listRuns` / `run.conversation()` only while a client is
 * actually looking at that chat. Fresh activity resets to the floor; quiet
 * chats stretch out so we do not look like a bot or keep a worker hot.
 */
export const CURSOR_CLOUD_MIRROR_BACKOFF_MS = [3_000, 8_000, 20_000, 45_000] as const;

export type CursorCloudMirrorRefreshResult = "new" | "unchanged" | "skipped";

/** Drop a failed cloud.attach lease so presence-gated polls can resume. */
export function releaseCursorCloudAttachLease(
  runtime: {
    cloudRuns: { delete: (runId: string) => void };
    activeCloudRunId: string | null;
    activeTurnId: string | null;
  },
  args: { runId: string; turnId: string },
): void {
  runtime.cloudRuns.delete(args.runId);
  if (runtime.activeCloudRunId === args.runId) runtime.activeCloudRunId = null;
  if (runtime.activeTurnId === args.turnId) runtime.activeTurnId = null;
}

export function nextCursorCloudMirrorDelay(
  currentDelayMs: number | null,
  result: CursorCloudMirrorRefreshResult,
): number {
  const floor = CURSOR_CLOUD_MIRROR_BACKOFF_MS[0];
  if (result === "new") return floor;
  if (result === "skipped") return currentDelayMs && currentDelayMs > 0 ? currentDelayMs : floor;
  if (currentDelayMs == null || currentDelayMs <= 0) return floor;
  const index = CURSOR_CLOUD_MIRROR_BACKOFF_MS.findIndex((ms) => ms === currentDelayMs);
  if (index < 0) return CURSOR_CLOUD_MIRROR_BACKOFF_MS[1] ?? floor;
  return CURSOR_CLOUD_MIRROR_BACKOFF_MS[Math.min(index + 1, CURSOR_CLOUD_MIRROR_BACKOFF_MS.length - 1)];
}
