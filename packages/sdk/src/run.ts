import { randomUUID } from "node:crypto";
import { AdeError } from "./errors.js";
import type { ThreadOpenOptions } from "./clientOptions.js";
import type { AdeThread } from "./thread.js";
import type { AdeProvider, AgentChatEventEnvelope } from "./types.js";
import type { ThreadBudget } from "./usage.js";

export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  title?: string;
  description?: string;
  $schema?: string;
  $id?: string;
  default?: unknown;
  examples?: unknown[];
};

export type RunOptions = Omit<ThreadOpenOptions, "provider" | "model"> & {
  provider: AdeProvider;
  model: string;
  schema?: JsonSchema;
  budget?: ThreadBudget;
  /**
   * Longest one turn may take, in ms (default 10 minutes). On expiry the turn
   * is interrupted and `run()` rejects with `rpc_timeout`.
   */
  timeoutMs?: number;
};

const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

/** Event types that park a turn until someone answers, which `run()` cannot. */
const WAITS_FOR_AN_ANSWER = new Set(["approval_request", "structured_question"]);

export class InvalidOutputError extends AdeError {
  readonly rawText: string;

  constructor(rawText: string, reason: string) {
    super("invalid_output", `The model returned output that did not match the requested schema: ${reason}`);
    this.rawText = rawText;
  }
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  "type", "properties", "required", "items", "enum", "additionalProperties",
  "title", "description", "$schema", "$id", "default", "examples",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateSchemaShape(schema: JsonSchema, path = "$schema"): void {
  if (!isRecord(schema)) throw new AdeError("invalid_option", `${path} must be an object.`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      throw new AdeError("invalid_option", `${path}.${key} is outside the SDK's supported JSON Schema subset.`);
    }
  }
  if (schema.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) {
    throw new AdeError("invalid_option", `${path}.type is not supported.`);
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new AdeError("invalid_option", `${path}.properties must be an object.`);
    for (const [key, child] of Object.entries(schema.properties)) validateSchemaShape(child, `${path}.properties.${key}`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) {
    throw new AdeError("invalid_option", `${path}.required must be an array of property names.`);
  }
  if (schema.items !== undefined) validateSchemaShape(schema.items, `${path}.items`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    throw new AdeError("invalid_option", `${path}.enum must be an array.`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    validateSchemaShape(schema.additionalProperties, `${path}.additionalProperties`);
  }
}

function matchesType(value: unknown, type: NonNullable<JsonSchema["type"]>): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
  }
}

export function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$", errors: string[] = []): string[] {
  if (schema.type && !matchesType(value, schema.type)) errors.push(`${path} must be ${schema.type}`);
  if (schema.enum && !schema.enum.some((entry) => canonicalJson(entry) === canonicalJson(value))) {
    errors.push(`${path} must match one of the enum values`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => validateJsonSchema(entry, schema.items!, `${path}[${index}]`, errors));
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) validateJsonSchema(entry, propertySchema, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
      else if (isRecord(schema.additionalProperties)) {
        validateJsonSchema(entry, schema.additionalProperties as JsonSchema, `${path}.${key}`, errors);
      }
    }
  }
  return errors;
}

type RunClient = {
  threads: {
    open(key: string, options: ThreadOpenOptions): Promise<AdeThread>;
    delete(key: string): Promise<void>;
  };
};

function appendSchemaInstructions(options: RunOptions): ThreadOpenOptions {
  const { schema, provider, model, budget, timeoutMs: _timeoutMs, ...openOptions } = options;
  if (!schema) return { ...openOptions, provider, model, ...(budget ? { budget } : {}) };

  const existing = openOptions.instructions;
  const existingText = typeof existing === "string" ? existing : existing?.text;
  const mode = typeof existing === "object" && existing !== null ? existing.mode : "append";
  const instruction = [
    existingText,
    "Return only a JSON value that validates against this JSON Schema. Do not use a Markdown code block.",
    JSON.stringify(schema),
  ].filter(Boolean).join("\n\n");
  return {
    ...openOptions,
    instructions: { mode, text: instruction },
    provider,
    model,
    ...(budget ? { budget } : {}),
  };
}

async function runTurn(thread: AdeThread, prompt: string, timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    let errorMessage: string | null = null;
    let settled = false;
    let stop: (() => void) | undefined;
    // A run that stops waiting must also stop the turn, or the provider keeps
    // working (and spending) on a thread that is about to be deleted.
    const abandon = (error: Error) => {
      // Settle first: the interrupt's own `done` must not resolve this run.
      finish(error);
      void thread.interrupt().catch(() => {});
    };
    const timer = setTimeout(() => {
      abandon(new AdeError("rpc_timeout", `client.run() gave up after ${timeoutMs} ms; pass a larger timeoutMs for long tasks.`));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.();
      if (error) reject(error);
      else resolve(output);
    };
    stop = thread.on("event", (envelope: AgentChatEventEnvelope) => {
      const event = envelope.event;
      if (WAITS_FOR_AN_ANSWER.has(event.type)) {
        abandon(new AdeError(
          "unsupported",
          "client.run() cannot answer approvals or questions. Give it permissions that need none " +
            "(for example permissions: \"always-allow\" with a sandboxed cwd), or use a thread.",
        ));
        return;
      }
      if (event.type === "text" && typeof event.text === "string") output += event.text;
      if (event.type === "error" && typeof event.message === "string") errorMessage = event.message;
      if (event.type === "done") {
        if (errorMessage) finish(new AdeError("rpc_error", errorMessage));
        else finish();
      } else if (event.type === "status" && event.synthetic === true && event.turnStatus === "failed") {
        finish(new AdeError("runtime_unavailable", typeof event.message === "string" ? event.message : "The runtime stopped during client.run()."));
      }
    });
    void thread.send(prompt).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/** Run one temporary thread, retrying once when structured output is invalid. */
export async function runOnce<T = unknown>(client: RunClient, prompt: string, options: RunOptions): Promise<T | string> {
  if (typeof prompt !== "string" || !prompt.trim()) throw new AdeError("invalid_option", "client.run() needs a non-empty prompt.");
  if (typeof options.model !== "string" || !options.model.trim()) throw new AdeError("invalid_option", "client.run() needs a model id.");
  if (options.schema) validateSchemaShape(options.schema);

  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AdeError("invalid_option", "client.run() timeoutMs must be a positive number of milliseconds.");
  }
  const key = `__ade_run_${randomUUID()}`;
  const thread = await client.threads.open(key, appendSchemaInstructions(options));
  try {
    let rawText = await runTurn(thread, prompt, timeoutMs);
    if (!options.schema) return rawText;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const parsed: unknown = JSON.parse(withoutCodeFence(rawText));
        const errors = validateJsonSchema(parsed, options.schema);
        if (!errors.length) return parsed as T;
        if (attempt === 1) throw new InvalidOutputError(rawText, errors.join("; "));
        rawText = await runTurn(
          thread,
          `Your previous response did not match the requested JSON Schema: ${errors.join("; ")}. ` +
            "Try once more and return only the corrected JSON value.",
          timeoutMs,
        );
      } catch (error) {
        if (error instanceof InvalidOutputError) throw error;
        if (error instanceof SyntaxError) {
          if (attempt === 1) throw new InvalidOutputError(rawText, "the output was not valid JSON");
          rawText = await runTurn(thread, "Your previous response was not valid JSON. Try once more and return only a corrected JSON value.", timeoutMs);
          continue;
        }
        throw error;
      }
    }
    throw new InvalidOutputError(rawText, "the output could not be validated");
  } finally {
    // Best effort: a failed cleanup must not replace the run's own result or
    // error. The key is unique to this run, so a leftover cannot be reopened.
    await client.threads.delete(key).catch(() => {});
  }
}

/**
 * Models often wrap JSON in a Markdown fence despite being told not to. Strip
 * exactly one fence around the whole answer, and nothing else.
 */
function withoutCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}
