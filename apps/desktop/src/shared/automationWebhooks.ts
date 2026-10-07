// Custom webhook triggers, shared by the runtime (normalize, filter, label)
// and the renderer (presets, previews). Pure: no Node or DOM APIs.

import type {
  AutomationWebhookFilter,
  AutomationWebhookFilterOp,
  AutomationWebhookPreset,
  AutomationWebhookSignatureConfig,
  AutomationWebhookTriggerConfig,
} from "./types/config";

export const WEBHOOK_HOOK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const WEBHOOK_FILTER_OPS: readonly AutomationWebhookFilterOp[] = ["equals", "not_equals", "contains", "exists", "matches"];

export type WebhookPresetDef = {
  value: AutomationWebhookPreset;
  label: string;
  /**
   * Who creates the signing secret. GitHub lets you type any secret, so ADE
   * generates one for you to paste there. Stripe, Linear and Sentry generate it
   * themselves, so you paste theirs into ADE.
   */
  secretSource: "you" | "sender";
  signature: Omit<AutomationWebhookSignatureConfig, "secretName">;
  /** Suggested project secret name for the signing secret. */
  secretName: string;
  /** Where the event name lives, for the deliveries list. */
  eventPaths: string[];
  /** Numbered steps shown next to the URL: where to paste what. */
  steps: string[];
  sampleHeaders: Record<string, string>;
  sampleBody: Record<string, unknown>;
  suggestedFilters: AutomationWebhookFilter[];
  suggestedPrompt: string;
};

export const WEBHOOK_PRESETS: readonly WebhookPresetDef[] = [
  {
    value: "github",
    label: "GitHub",
    secretSource: "you",
    signature: { scheme: "hmac", header: "x-hub-signature-256", prefix: "sha256=", encoding: "hex" },
    secretName: "GITHUB_WEBHOOK_SECRET",
    eventPaths: ["headers.x-github-event", "body.action"],
    steps: [
      "Open your repository → Settings → Webhooks → Add webhook.",
      "Paste the URL into Payload URL and set Content type to application/json.",
      "Paste the signing secret into Secret.",
      "Pick the events you want (e.g. Issues), then Add webhook.",
    ],
    sampleHeaders: { "x-github-event": "issues", "content-type": "application/json" },
    sampleBody: {
      action: "opened",
      issue: {
        number: 45,
        title: "Login button does nothing on Safari",
        body: "Steps: open /login in Safari 18, click Sign in. Nothing happens.",
        html_url: "https://github.com/acme/web/issues/45",
        user: { login: "bob" },
      },
      repository: { full_name: "acme/web" },
      sender: { login: "bob" },
    },
    suggestedFilters: [
      { path: "headers.x-github-event", op: "equals", value: "issues" },
      { path: "body.action", op: "equals", value: "opened" },
    ],
    suggestedPrompt:
      "Triage GitHub issue #{{trigger.body.issue.number}} in {{trigger.body.repository.full_name}}: {{trigger.body.issue.title}}\n\n{{trigger.body.issue.body}}\n\nReproduce it, find the cause, and propose a fix.",
  },
  {
    value: "stripe",
    label: "Stripe",
    secretSource: "sender",
    signature: { scheme: "stripe", header: "stripe-signature" },
    secretName: "STRIPE_WEBHOOK_SECRET",
    eventPaths: ["body.type"],
    steps: [
      "In Stripe, open Developers → Webhooks → Add endpoint.",
      "Paste the URL into Endpoint URL and choose the events to send.",
      "After saving, reveal the Signing secret (starts with whsec_). Save that value in ADE as the signing secret.",
    ],
    sampleHeaders: { "content-type": "application/json" },
    sampleBody: {
      id: "evt_1Q2w3E4r",
      type: "invoice.payment_failed",
      data: { object: { id: "in_1Q2w3E", customer_email: "dana@example.com", amount_due: 4900, attempt_count: 2 } },
    },
    suggestedFilters: [{ path: "body.type", op: "equals", value: "invoice.payment_failed" }],
    suggestedPrompt:
      "A Stripe payment failed for {{trigger.body.data.object.customer_email}} (invoice {{trigger.body.data.object.id}}, attempt {{trigger.body.data.object.attempt_count}}). Check our billing code for anything that could explain it.",
  },
  {
    value: "linear",
    label: "Linear",
    secretSource: "sender",
    signature: { scheme: "hmac", header: "linear-signature", prefix: "", encoding: "hex" },
    secretName: "LINEAR_WEBHOOK_SECRET",
    eventPaths: ["body.type", "body.action"],
    steps: [
      "In Linear, open Settings → API → Webhooks → New webhook.",
      "Paste the URL, pick the data types to send, and create it.",
      "Copy the signing secret Linear shows. Save that value in ADE as the signing secret.",
    ],
    sampleHeaders: { "content-type": "application/json", "linear-event": "Issue" },
    sampleBody: {
      action: "create",
      type: "Issue",
      data: { identifier: "ENG-112", title: "Export to CSV drops the last row", description: "Happens on every export over 100 rows." },
      url: "https://linear.app/acme/issue/ENG-112",
    },
    suggestedFilters: [{ path: "body.action", op: "equals", value: "create" }],
    suggestedPrompt: "New Linear issue {{trigger.body.data.identifier}}: {{trigger.body.data.title}}\n\n{{trigger.body.data.description}}",
  },
  {
    value: "sentry",
    label: "Sentry",
    secretSource: "sender",
    signature: { scheme: "hmac", header: "sentry-hook-signature", prefix: "", encoding: "hex" },
    secretName: "SENTRY_WEBHOOK_SECRET",
    eventPaths: ["headers.sentry-hook-resource", "body.action"],
    steps: [
      "In Sentry, open Settings → Developer Settings → Custom Integrations → Create New Integration (Internal).",
      "Paste the URL into Webhook URL and enable the Issue or Error alerts you want.",
      "Copy the integration's Client Secret. Save that value in ADE as the signing secret.",
    ],
    sampleHeaders: { "content-type": "application/json", "sentry-hook-resource": "issue" },
    sampleBody: {
      action: "created",
      data: { issue: { id: "4512", title: "TypeError: Cannot read properties of undefined (reading 'id')", culprit: "app/routes/checkout.ts", web_url: "https://sentry.io/issues/4512/" } },
    },
    suggestedFilters: [{ path: "body.action", op: "equals", value: "created" }],
    suggestedPrompt:
      "Sentry reported a new error: {{trigger.body.data.issue.title}} in {{trigger.body.data.issue.culprit}} ({{trigger.body.data.issue.web_url}}). Find the cause and propose a fix.",
  },
  {
    value: "generic",
    label: "Anything else",
    secretSource: "you",
    signature: { scheme: "hmac", header: "x-signature", prefix: "sha256=", encoding: "hex" },
    secretName: "WEBHOOK_SECRET",
    eventPaths: ["body.event", "body.type"],
    steps: [
      "Paste the URL wherever the service asks for a webhook or callback URL.",
      "If it can sign requests, give it the signing secret and turn on Require signature.",
      "Use Send test to see a delivery arrive before you wire up the real service.",
    ],
    sampleHeaders: { "content-type": "application/json" },
    sampleBody: { event: "deploy.failed", service: "api", environment: "production", url: "https://example.com/deploys/812" },
    suggestedFilters: [],
    suggestedPrompt: "The {{trigger.body.service}} deploy to {{trigger.body.environment}} failed ({{trigger.body.url}}). Find out why.",
  },
];

export function webhookPresetDef(value: AutomationWebhookPreset | null | undefined): WebhookPresetDef {
  return WEBHOOK_PRESETS.find((preset) => preset.value === value) ?? WEBHOOK_PRESETS[WEBHOOK_PRESETS.length - 1]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeWebhookSignature(raw: unknown): AutomationWebhookSignatureConfig | null {
  if (!isRecord(raw)) return null;
  const scheme = raw.scheme === "stripe" ? "stripe" : "hmac";
  const header = trimmed(raw.header).toLowerCase();
  const secretName = trimmed(raw.secretName);
  if (!header || !secretName) return null;
  const out: AutomationWebhookSignatureConfig = { scheme, header, secretName };
  if (scheme === "hmac") {
    out.prefix = typeof raw.prefix === "string" ? raw.prefix : "";
    out.encoding = raw.encoding === "base64" ? "base64" : "hex";
  }
  return out;
}

export function normalizeWebhookFilters(raw: unknown): AutomationWebhookFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: AutomationWebhookFilter[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const path = trimmed(entry.path);
    const op = WEBHOOK_FILTER_OPS.includes(entry.op as AutomationWebhookFilterOp) ? (entry.op as AutomationWebhookFilterOp) : null;
    if (!path || !op) continue;
    const filter: AutomationWebhookFilter = { path, op };
    if (op !== "exists") filter.value = typeof entry.value === "string" ? entry.value : String(entry.value ?? "");
    out.push(filter);
  }
  return out.slice(0, 20);
}

/** Config read/write: keep only what the runtime understands. */
export function normalizeWebhookTriggerConfig(raw: unknown): AutomationWebhookTriggerConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const hookId = trimmed(raw.hookId).toLowerCase();
  if (!WEBHOOK_HOOK_ID_PATTERN.test(hookId)) return undefined;
  const out: AutomationWebhookTriggerConfig = { hookId };
  const preset = WEBHOOK_PRESETS.find((entry) => entry.value === raw.preset)?.value;
  if (preset) out.preset = preset;
  const signature = normalizeWebhookSignature(raw.signature);
  if (signature) out.signature = signature;
  const filters = normalizeWebhookFilters(raw.filters);
  if (filters.length) out.filters = filters;
  const maxAge = Number(raw.maxAgeMinutes);
  if (Number.isFinite(maxAge) && maxAge > 0) out.maxAgeMinutes = Math.min(7 * 24 * 60, Math.floor(maxAge));
  return out;
}

/** The parts of a request a filter or placeholder can read. */
export type WebhookRequestView = {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
};

/**
 * Read `body.a.b`, `headers.x-github-event`, `query.env`. A leading `trigger.`
 * is accepted so filter paths and prompt placeholders read the same way.
 * Array indexes are plain segments: `body.commits.0.id`.
 */
export function readWebhookPath(view: WebhookRequestView, path: string): unknown {
  const segments = path.trim().replace(/^trigger\./, "").split(".").filter(Boolean);
  const [root, ...rest] = segments;
  let cursor: unknown =
    root === "body" ? view.body : root === "headers" ? view.headers : root === "query" ? view.query : undefined;
  if (root === "headers" && rest.length) {
    // Header names are case-insensitive and may contain dots, so read the rest as one key.
    return view.headers[rest.join(".").toLowerCase()];
  }
  for (const segment of rest) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function filterValueText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Returns the first filter that fails, or null when every filter passes. */
/** A `matches` condition reads at most this much of a field. */
export const WEBHOOK_REGEX_INPUT_MAX_CHARS = 10_000;

export function firstFailingWebhookFilter(
  filters: readonly AutomationWebhookFilter[] | undefined,
  view: WebhookRequestView,
): AutomationWebhookFilter | null {
  for (const filter of filters ?? []) {
    const actual = readWebhookPath(view, filter.path);
    const actualText = filterValueText(actual);
    const expected = filter.value ?? "";
    let passes: boolean;
    switch (filter.op) {
      case "exists":
        passes = actual !== undefined && actual !== null && actualText !== "";
        break;
      case "equals":
        passes = actualText.toLowerCase() === expected.toLowerCase();
        break;
      case "not_equals":
        passes = actualText.toLowerCase() !== expected.toLowerCase();
        break;
      case "contains":
        passes = actualText.toLowerCase().includes(expected.toLowerCase());
        break;
      case "matches":
        try {
          // The sender writes the text; a pattern with heavy backtracking must
          // not get an unbounded input to chew on.
          passes = new RegExp(expected, "i").test(actualText.slice(0, WEBHOOK_REGEX_INPUT_MAX_CHARS));
        } catch {
          passes = false;
        }
        break;
      default:
        passes = false;
    }
    if (!passes) return filter;
  }
  return null;
}

export function describeWebhookFilter(filter: AutomationWebhookFilter): string {
  const path = filter.path.replace(/^trigger\./, "");
  switch (filter.op) {
    case "exists":
      return `${path} is present`;
    case "equals":
      return `${path} is "${filter.value ?? ""}"`;
    case "not_equals":
      return `${path} is not "${filter.value ?? ""}"`;
    case "contains":
      return `${path} contains "${filter.value ?? ""}"`;
    case "matches":
      return `${path} matches /${filter.value ?? ""}/`;
    default:
      return path;
  }
}

/** `issues.opened`, `invoice.payment_failed`: a short label for the deliveries list. */
export function webhookEventLabel(view: WebhookRequestView, preset: AutomationWebhookPreset | null | undefined): string | null {
  const parts = webhookPresetDef(preset)
    .eventPaths.map((path) => readWebhookPath(view, path))
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return parts.length ? parts.join(".") : null;
}

/** Every leaf path in a JSON value, for "insert from a real delivery" pickers. */
export function listWebhookLeafPaths(value: unknown, prefix = "body", limit = 200): Array<{ path: string; sample: string }> {
  const out: Array<{ path: string; sample: string }> = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (out.length >= limit) return;
    if (node != null && typeof node === "object" && depth < 6) {
      const entries = Array.isArray(node) ? node.slice(0, 3).map((entry, index) => [String(index), entry] as const) : Object.entries(node);
      for (const [key, child] of entries) walk(child, `${path}.${key}`, depth + 1);
      return;
    }
    const sample = filterValueText(node);
    out.push({ path, sample: sample.length > 80 ? `${sample.slice(0, 77)}…` : sample });
  };
  walk(value, prefix, 0);
  return out;
}
