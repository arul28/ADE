/**
 * Worker-side bridge between Pi's callback-shaped UI APIs and ADE's chat cards.
 *
 * Pi asks the human questions from three unrelated places — `AuthInteraction`
 * during login, a custom tool's `execute`, and an extension's UI context — and
 * all three are plain callbacks that block until they get a value back. This
 * module funnels them into one reverse-RPC channel so the desktop process has a
 * single place to render a card and a single place to fail one closed.
 *
 * Deliberately free of Pi imports: the desktop process bundles this file into
 * the worker, which loads the user's Pi installation only after init validation.
 */
import { PI_APPROVAL_ALLOW, PI_APPROVAL_ALLOW_SESSION } from "./piSdkEventMapper";
import {
  PI_SDK_PROTOCOL_VERSION,
  type PiSdkUiNoticePayload,
  type PiSdkUiOption,
  type PiSdkUiOrigin,
  type PiSdkUiPromptKind,
  type PiSdkUiRequestPayload,
  type PiSdkUiResponsePayload,
  type PiSdkWorkerResponse,
} from "./piSdkProtocol";

export type PiUiBridge = {
  /**
   * Ask the desktop process a question. Never rejects — a dismissed card, an
   * aborted turn, or a disposed worker all resolve to `null`, so a Pi callback
   * awaiting an answer degrades to "no answer" instead of throwing through the
   * SDK's own error channel.
   */
  request: (payload: PiSdkUiRequestPayload, options?: PiUiRequestOptions) => Promise<string | null>;
  notify: (payload: PiSdkUiNoticePayload) => void;
  /** Settle a pending request with the desktop process's answer. */
  resolve: (requestId: string, response: PiSdkUiResponsePayload) => boolean;
  /**
   * Resolve outstanding requests to `null` without closing the bridge — used
   * when a turn is aborted or a login is cancelled. Pass an origin to drain
   * only that surface, so cancelling a sign-in leaves a tool's card alone.
   */
  drain: (origin?: PiSdkUiOrigin) => void;
  /** Drain everything and refuse further requests. Terminal. */
  close: () => void;
  pendingCount: () => number;
};

export type PiUiRequestOptions = {
  /** Honours the caller's own deadline; Pi extensions supply this themselves. */
  timeoutMs?: number;
  signal?: { aborted: boolean; addEventListener: (type: "abort", listener: () => void, options?: { once?: boolean }) => void; removeEventListener: (type: "abort", listener: () => void) => void } | null;
};

type PendingUiRequest = {
  origin: PiSdkUiOrigin;
  /** `fromDesktop` suppresses the `ui_cancel` echo for an answer we were given. */
  settle: (value: string | null, fromDesktop?: boolean) => void;
};

export function createPiUiBridge(
  post: (message: PiSdkWorkerResponse) => void,
  makeId: () => string,
): PiUiBridge {
  const pending = new Map<string, PendingUiRequest>();
  let closed = false;

  const request = (payload: PiSdkUiRequestPayload, options?: PiUiRequestOptions): Promise<string | null> => {
    if (closed || options?.signal?.aborted) return Promise.resolve(null);
    const requestId = makeId();
    return new Promise<string | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => settle(null);
      const settle = (value: string | null, fromDesktop = false): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        pending.delete(requestId);
        // A settle the desktop did not ask for — an extension's own timeout or
        // abort signal — would otherwise leave its card on screen forever.
        if (!fromDesktop && !closed) {
          post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "ui_cancel", requestId });
        }
        resolve(value);
      };

      // Register before emitting so a synchronous answer cannot race the map.
      pending.set(requestId, { origin: payload.origin, settle });
      try {
        if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
          timer = setTimeout(onAbort, options.timeoutMs);
          timer.unref?.();
        }
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "ui_request", requestId, payload });
      } catch {
        // An extension can hand over a signal-shaped object whose methods
        // throw. Settling keeps the never-rejects contract and stops the entry
        // leaking into `pending`.
        settle(null);
      }
    });
  };

  return {
    request,
    notify: (payload) => {
      if (closed) return;
      post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "ui_notice", payload });
    },
    resolve: (requestId, response) => {
      const waiter = pending.get(requestId);
      if (!waiter) return false;
      waiter.settle(response.ok ? response.value ?? "" : null, true);
      return true;
    },
    drain: (origin) => {
      for (const waiter of [...pending.values()]) {
        if (origin === undefined || waiter.origin === origin) waiter.settle(null);
      }
    },
    close: () => {
      closed = true;
      for (const waiter of [...pending.values()]) waiter.settle(null);
      pending.clear();
    },
    pendingCount: () => pending.size,
  };
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Pi hands extensions a bare `string[]` of choices and expects the chosen
 * string back verbatim. ADE's cards need a stable value and a unique label, so
 * duplicates are disambiguated for display while `value` keeps the original —
 * including any whitespace the extension deliberately included.
 */
export function piUiOptionsFromLabels(labels: readonly string[]): Array<PiSdkUiOption & { original: string }> {
  const seen = new Map<string, number>();
  return labels.map((label, index) => {
    const base = trimmed(label) ?? `Option ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return {
      value: String(index),
      label: count === 1 ? base : `${base} (${count})`,
      description: base,
      original: label,
    };
  });
}

/**
 * A no-op ANSI theme.
 *
 * Extensions call `ui.theme.bold(...)` unconditionally while rendering, so the
 * property has to exist and return plain text rather than be absent.
 */
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  dim: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (text: string) => text,
  getBashModeBorderColor: () => (text: string) => text,
};

export type PiExtensionUiContextOptions = {
  bridge: PiUiBridge;
  /** Emitted once per unsupported API so a chatty extension cannot spam the thread. */
  onUnsupported?: (method: string) => void;
};

/**
 * Implement Pi's `ExtensionUIContext` over ADE's card bridge.
 *
 * Three tiers: `select`/`confirm`/`input`/`editor` become real ADE cards,
 * `notify`/`setStatus`/`setWorkingMessage`/`setTitle` become thread notices,
 * and the TUI-only surface (widgets, footers, editor hooks, themes) no-ops —
 * warning once for anything whose absence the user could actually notice.
 */
export function createPiExtensionUiContext(options: PiExtensionUiContextOptions): Record<string, unknown> {
  const { bridge } = options;
  const warned = new Set<string>();
  const statuses = new Map<string, string>();
  let workingMessage: string | null = null;

  const warnUnsupported = (method: string): void => {
    if (warned.has(method)) return;
    warned.add(method);
    options.onUnsupported?.(method);
    bridge.notify({
      origin: "extension",
      level: "warn",
      message: `This Pi extension used "${method}", which only works in Pi's terminal UI. ADE ignored it.`,
      detail: { method },
    });
  };
  const progress = (message: string): void => {
    const normalized = trimmed(message);
    if (normalized) bridge.notify({ origin: "extension", level: "progress", message: normalized });
  };
  const promptOptions = (opts: unknown): PiUiRequestOptions => {
    const record = opts && typeof opts === "object" ? opts as Record<string, unknown> : {};
    // An extension supplies these values, so a malformed `signal` must not
    // reach `bridge.request` — calling addEventListener on it would throw and
    // break the promise's never-rejecting contract.
    const candidate = record.signal as { addEventListener?: unknown; removeEventListener?: unknown } | null | undefined;
    const usableSignal = candidate
      && typeof candidate.addEventListener === "function"
      && typeof candidate.removeEventListener === "function"
      ? candidate as PiUiRequestOptions["signal"]
      : null;
    return {
      ...(typeof record.timeout === "number" && record.timeout > 0 ? { timeoutMs: record.timeout } : {}),
      ...(usableSignal ? { signal: usableSignal } : {}),
    };
  };

  const context: Record<string, unknown> = {
    async select(title: string, choices: string[], opts?: unknown): Promise<string | undefined> {
      const mapped = piUiOptionsFromLabels(Array.isArray(choices) ? choices : []);
      const answer = await bridge.request({
        origin: "extension",
        kind: "select",
        title: trimmed(title) ?? "Pi extension",
        message: trimmed(title) ?? "Choose an option.",
        options: mapped.map(({ value, label, description }) => ({ value, label, description })),
      }, promptOptions(opts));
      if (answer === null) return undefined;
      // Match on value first (what ADE's card sends back), then on the visible
      // label so a surface that echoes the label still resolves.
      const chosen = mapped.find((option) => option.value === answer)
        ?? mapped.find((option) => option.label === answer);
      return chosen?.original;
    },
    async confirm(title: string, message?: string, opts?: unknown): Promise<boolean> {
      const answer = await bridge.request({
        origin: "extension",
        kind: "confirm",
        title: trimmed(title) ?? "Pi extension",
        message: trimmed(message) ?? trimmed(title) ?? "Confirm this action?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      }, promptOptions(opts));
      // Dismissal, timeout, and abort all land here as `null` — deny.
      return answer === "yes";
    },
    async input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined> {
      const answer = await bridge.request({
        origin: "extension",
        kind: "text",
        title: trimmed(title) ?? "Pi extension",
        message: trimmed(title) ?? trimmed(placeholder) ?? "Type a response.",
        ...(trimmed(placeholder) ? { placeholder: trimmed(placeholder) } : {}),
      }, promptOptions(opts));
      return answer === null ? undefined : answer;
    },
    editor(title: string, prefill?: string): Promise<string | undefined> {
      return (context.input as (t: string, p?: string) => Promise<string | undefined>)(title, prefill);
    },
    notify(message: string, type?: string): void {
      const normalized = trimmed(message);
      if (!normalized) return;
      if (type === "warning" || type === "error") {
        bridge.notify({ origin: "extension", level: type === "error" ? "error" : "warn", message: normalized });
        return;
      }
      progress(normalized);
    },
    setStatus(key: string, text?: string): void {
      const normalizedKey = trimmed(key) ?? "status";
      const normalizedText = trimmed(text);
      if (!normalizedText) {
        statuses.delete(normalizedKey);
        return;
      }
      // Extensions re-set the same status on every render tick.
      if (statuses.get(normalizedKey) === normalizedText) return;
      statuses.set(normalizedKey, normalizedText);
      progress(`${normalizedKey}: ${normalizedText}`);
    },
    setWorkingMessage(message: string): void {
      const normalized = trimmed(message);
      if (!normalized || normalized === workingMessage) return;
      workingMessage = normalized;
      progress(normalized);
    },
    setTitle(title: string): void {
      if (trimmed(title)) progress(trimmed(title)!);
    },

    // Visual-only in Pi's TUI; silently ignored because nothing is lost.
    setWorkingVisible(): void {},
    setWorkingIndicator(): void {},
    setHiddenThinkingLabel(): void {},
    setToolsExpanded(): void {},
    getToolsExpanded(): boolean { return false; },

    // Surfaces whose absence the user could notice — warn once each.
    setWidget(): void { warnUnsupported("setWidget"); },
    setFooter(): void { warnUnsupported("setFooter"); },
    setHeader(): void { warnUnsupported("setHeader"); },
    async custom(): Promise<undefined> { warnUnsupported("custom"); return undefined; },
    onTerminalInput(): () => void { warnUnsupported("onTerminalInput"); return () => undefined; },
    pasteToEditor(): void { warnUnsupported("pasteToEditor"); },
    setEditorText(): void { warnUnsupported("setEditorText"); },
    getEditorText(): string { return ""; },
    addAutocompleteProvider(): void { warnUnsupported("addAutocompleteProvider"); },
    setEditorComponent(): void { warnUnsupported("setEditorComponent"); },
    getEditorComponent(): undefined { return undefined; },

    theme: PLAIN_THEME,
    getAllThemes(): unknown[] { return []; },
    getTheme(): undefined { return undefined; },
    setTheme(): { success: false; error: string } {
      return { success: false, error: "ADE renders Pi extensions with its own chat styling." };
    },
  };
  return context;
}

/** Pi's `AuthPrompt`, narrowed to the fields ADE reads. */
type PiAuthPrompt = {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
  signal?: PiUiRequestOptions["signal"];
};

/** Pi's `AuthEvent`, narrowed to the fields ADE reads. */
type PiAuthEvent =
  | { type: "info"; message: string; links?: ReadonlyArray<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

/** Message Pi's own TUI uses for a user-cancelled login; Pi suppresses its error toast on this text. */
export const PI_LOGIN_CANCELLED_MESSAGE = "Login cancelled";

/**
 * Build the `AuthInteraction` ADE hands to `ModelRuntime.login`.
 *
 * ADE never sees a token: Pi's own `AuthStorage` writes `auth.json` under its
 * cross-process lock. This only renders Pi's prompts and returns what the user
 * typed or picked.
 */
export function createPiAuthInteraction(
  bridge: PiUiBridge,
  providerId: string,
  signal?: AbortSignal,
): { signal?: AbortSignal; prompt: (prompt: PiAuthPrompt) => Promise<string>; notify: (event: PiAuthEvent) => void } {
  return {
    ...(signal ? { signal } : {}),
    prompt: async (prompt: PiAuthPrompt): Promise<string> => {
      const kind: PiSdkUiPromptKind = prompt.type === "select"
        ? "select"
        : prompt.type === "secret"
          ? "secret"
          : prompt.type === "manual_code"
            ? "manual_code"
            : "text";
      const answer = await bridge.request({
        origin: "auth",
        kind,
        title: `Sign in to ${providerId}`,
        message: trimmed(prompt.message) ?? "Pi needs a value to continue signing in.",
        sourceId: providerId,
        ...(trimmed(prompt.placeholder) ? { placeholder: trimmed(prompt.placeholder) } : {}),
        // Pi resolves a `select` prompt by option id, so the card's value must
        // be the id rather than the visible label.
        ...(prompt.type === "select" && Array.isArray(prompt.options)
          ? {
              options: prompt.options.map((option) => ({
                value: option.id,
                label: trimmed(option.label) ?? option.id,
                ...(trimmed(option.description) ? { description: trimmed(option.description) } : {}),
              })),
            }
          : {}),
      }, {
        // Pi aborts an individual prompt when an out-of-band step wins the race
        // (a manual-code entry superseded by the OAuth callback server).
        ...(prompt.signal ? { signal: prompt.signal } : {}),
      });
      // Pi's contract is reject-on-cancel, not resolve-with-undefined.
      if (answer === null) throw new Error(PI_LOGIN_CANCELLED_MESSAGE);
      return answer;
    },
    notify: (event: PiAuthEvent): void => {
      if (event.type === "auth_url") {
        bridge.notify({
          origin: "auth",
          level: "info",
          message: trimmed(event.instructions) ?? "Open this URL to continue signing in.",
          sourceId: providerId,
          detail: { kind: "auth_url", url: event.url },
        });
        return;
      }
      if (event.type === "device_code") {
        bridge.notify({
          origin: "auth",
          level: "info",
          message: `Enter code ${event.userCode} at ${event.verificationUri}`,
          sourceId: providerId,
          detail: {
            kind: "device_code",
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            ...(event.expiresInSeconds != null ? { expiresInSeconds: event.expiresInSeconds } : {}),
          },
        });
        return;
      }
      if (event.type === "info") {
        bridge.notify({
          origin: "auth",
          level: "info",
          message: trimmed(event.message) ?? "",
          sourceId: providerId,
          ...(event.links?.length ? { detail: { kind: "info", links: event.links.map((link) => ({ url: link.url, ...(link.label ? { label: link.label } : {}) })) } } : {}),
        });
        return;
      }
      bridge.notify({
        origin: "auth",
        level: "progress",
        message: trimmed(event.message) ?? "Working…",
        sourceId: providerId,
      });
    },
  };
}

/** JSON Schema for the `ask_user` tool ADE injects into Pi sessions. */
export const PI_ASK_USER_TOOL_NAME = "ask_user";

export const PI_ASK_USER_PARAMETERS = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question to ask. Be specific and self-contained.",
    },
    header: {
      type: "string",
      description: "Short label for the question card, 12 characters or fewer.",
    },
    options: {
      type: "array",
      description: "Optional choices. Omit for a free-text answer.",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short choice text shown to the user." },
          description: { type: "string", description: "What picking this choice means." },
        },
        required: ["label"],
      },
    },
  },
  required: ["question"],
} as const;

export const PI_ASK_USER_DESCRIPTION = [
  "Ask the user a question and wait for their answer.",
  "Use this only when you are blocked on a decision that is genuinely theirs —",
  "one you cannot resolve from the request, the code, or a sensible default.",
  "Provide `options` when the answer is a choice between known alternatives;",
  "omit them for free-text. The tool returns the user's answer, or a note that",
  "they declined, in which case proceed with your best judgement.",
].join(" ");

/** Normalize the model's `ask_user` arguments into an ADE card request. */
export function piAskUserRequestFromArgs(args: unknown): PiSdkUiRequestPayload {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const question = trimmed(record.question) ?? "The agent needs your input before it can continue.";
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  const options = rawOptions.flatMap((option, index): PiSdkUiOption[] => {
    const entry = option && typeof option === "object" ? option as Record<string, unknown> : {};
    const label = trimmed(entry.label);
    if (!label) return [];
    return [{
      value: String(index),
      label,
      ...(trimmed(entry.description) ? { description: trimmed(entry.description) } : {}),
    }];
  });
  return {
    origin: "tool",
    kind: options.length ? "select" : "text",
    title: trimmed(record.header) ?? "Question",
    message: question,
    sourceId: PI_ASK_USER_TOOL_NAME,
    ...(options.length ? { options } : {}),
  };
}

/** Map an ADE card answer back to the text the model receives. */
export function piAskUserResultText(request: PiSdkUiRequestPayload, answer: string | null): string {
  if (answer === null) {
    return "The user did not answer. Continue with your best judgement and state the assumption you made.";
  }
  const chosen = request.options?.find((option) => option.value === answer);
  return `The user answered: ${chosen ? chosen.label : answer}`;
}

/**
 * Human-readable one-liner describing a tool call awaiting approval.
 *
 * Pi's built-in tools use stable argument names, so the common cases read as a
 * command or a path rather than as a JSON blob.
 */
export function piApprovalSummary(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const command = trimmed(record.command);
  if (command) return command;
  const filePath = trimmed(record.filePath) ?? trimmed(record.path) ?? trimmed(record.file);
  if (filePath) return filePath;
  try {
    const encoded = JSON.stringify(record);
    return encoded.length > 300 ? `${encoded.slice(0, 300)}…` : encoded;
  } catch {
    return toolName;
  }
}

/**
 * Minimal shape of a Pi `ToolDefinition`.
 *
 * The worker loads Pi dynamically and cannot import its types, so tool
 * definitions are described structurally. `parameters` is a TypeBox schema in
 * Pi's typings, which at runtime is a plain JSON Schema object.
 */
export type PiToolDefinitionLike = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
};

/** ADE's `ask_user` tool, resolved through the chat's question card. */
export function createPiAskUserTool(bridge: PiUiBridge): PiToolDefinitionLike {
  return {
    name: PI_ASK_USER_TOOL_NAME,
    label: "Ask user",
    description: PI_ASK_USER_DESCRIPTION,
    promptSnippet: "ask_user: ask the user a question and wait for their answer",
    parameters: PI_ASK_USER_PARAMETERS,
    execute: async (_toolCallId, params, signal) => {
      const request = piAskUserRequestFromArgs(params);
      const answer = await bridge.request(request, { ...(signal ? { signal } : {}) });
      const text = piAskUserResultText(request, answer);
      return { content: [{ type: "text", text }], details: { answered: answer !== null, answer } };
    },
  };
}

export type PiApprovalGate = {
  /** Resolves true when the call may proceed. */
  check: (toolName: string, args: unknown, signal: AbortSignal | undefined) => Promise<boolean>;
};

/**
 * Ask before each call to a gated tool, remembering an "allow for this chat"
 * answer so the user is not asked about the same tool repeatedly.
 */
export function createPiApprovalGate(bridge: PiUiBridge): PiApprovalGate {
  const alwaysAllow = new Set<string>();
  return {
    check: async (toolName, args, signal) => {
      if (alwaysAllow.has(toolName)) return true;
      const answer = await bridge.request(piApprovalRequest(toolName, args), { ...(signal ? { signal } : {}) });
      if (answer === PI_APPROVAL_ALLOW_SESSION) {
        alwaysAllow.add(toolName);
        return true;
      }
      // A dismissed card or an aborted turn denies the call.
      return answer === PI_APPROVAL_ALLOW;
    },
  };
}

/**
 * Wrap a Pi tool definition so the call clears an ADE approval card first.
 *
 * The wrapper keeps the original name, so registering it through `customTools`
 * replaces Pi's built-in of the same name while preserving its schema, prompt
 * text, and rendering.
 */
export function withPiApproval(
  definition: PiToolDefinitionLike,
  gate: PiApprovalGate,
): PiToolDefinitionLike {
  return {
    ...definition,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (!await gate.check(definition.name, params, signal)) {
        // Pi marks a tool call failed only when execute throws.
        throw new Error(`The user denied this ${definition.name} call. Ask before trying it again, or take a different approach.`);
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export function piApprovalRequest(toolName: string, args: unknown): PiSdkUiRequestPayload {
  // No options: ADE renders an approval card with its own accept/decline
  // controls and never reads `questions[].options`, so supplying them would
  // ship labels nothing displays.
  return {
    origin: "approval",
    kind: "confirm",
    title: `Run ${toolName}?`,
    message: piApprovalSummary(toolName, args),
    sourceId: toolName,
  };
}
