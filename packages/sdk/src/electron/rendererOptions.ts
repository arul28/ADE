/**
 * What a renderer may put in the options of a bridge call.
 *
 * The renderer is the least trusted process in an Electron app, and a thread
 * key carries a tool surface, a policy and a working directory. So the bridge
 * rebuilds every renderer option object field by field and drops the rest,
 * with one log line per dropped field.
 */

import type { ThreadResumeOptions } from "../client.js";
import type { AgentChatFileRef } from "../types.js";

/** The renderer `threads.open` fields the bridge forwards without an `openOptions` hook. */
export const ADE_IPC_RENDERER_OPEN_FIELDS = ["provider", "model", "title", "reasoningEffort"] as const;

/** The `threads.open` options a renderer may choose (see `rendererOpenOptions`). */
export type RendererOpenOptions = Pick<ThreadResumeOptions, (typeof ADE_IPC_RENDERER_OPEN_FIELDS)[number]>;

/**
 * The `threads.open` options a renderer may choose when the host has no
 * `openOptions` hook: `ADE_IPC_RENDERER_OPEN_FIELDS`, strings only. Null when
 * none remain.
 */
export function rendererOpenOptions(
  key: string,
  rendererOptions: Record<string, unknown> | undefined,
  log: (line: string) => void,
): RendererOpenOptions | null {
  if (!rendererOptions) return null;
  const allowed = new Set<string>(ADE_IPC_RENDERER_OPEN_FIELDS);
  const filtered: Record<string, string> = {};
  for (const [field, value] of Object.entries(rendererOptions)) {
    if (value === undefined) continue;
    if (!allowed.has(field)) {
      log(
        `[ade-electron] threads.open "${key}": dropped renderer option "${field}"; ` +
          `only ${ADE_IPC_RENDERER_OPEN_FIELDS.join(", ")} cross the bridge. Use the openOptions hook to configure threads.`,
      );
      continue;
    }
    if (typeof value !== "string") {
      log(`[ade-electron] threads.open "${key}": dropped renderer option "${field}" (not a string)`);
      continue;
    }
    filtered[field] = value;
  }
  // Every key passed the ADE_IPC_RENDERER_OPEN_FIELDS check above, and each
  // of those fields is a string option.
  return Object.keys(filtered).length > 0 ? (filtered as RendererOpenOptions) : null;
}

/** The options `thread.send`, `thread.steer` and `thread.editLast` accept from a renderer. */
export type RendererSendOptions = {
  attachments?: AgentChatFileRef[];
  displayText?: string;
  reasoningEffort?: string | null;
};

/**
 * The send-style options a renderer may pass, rebuilt field by field. Before
 * 0.4 the object crossed unfiltered.
 *
 * Kept: `displayText` and `reasoningEffort` (strings), and `attachments` with
 * `path`, `name`, `mimeType`, `bytes`, `type` and `hydrate` of the right types.
 * An explicit empty `attachments` list stays empty (for `editLast`, it removes
 * the original attachments; for a send it is the same as none). Anything else
 * is dropped with one log line. The runtime's own path rules still decide
 * which attachment paths it reads.
 */
export function rendererSendOptions(
  method: string,
  key: string,
  raw: unknown,
  log: (line: string) => void,
): RendererSendOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: RendererSendOptions = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (field === "displayText" && typeof value === "string") out.displayText = value;
    else if (field === "reasoningEffort" && (typeof value === "string" || value === null)) out.reasoningEffort = value;
    else if (field === "attachments" && Array.isArray(value)) {
      // Only an explicitly empty list crosses empty; a list whose every entry
      // was unusable is dropped like any other unusable field.
      const refs = value.flatMap(rendererFileRef);
      if (value.length === 0 || refs.length > 0) out.attachments = refs;
      else log(`[ade-electron] ${method} "${key}": dropped "attachments": no entry has a usable path`);
    } else {
      log(`[ade-electron] ${method} "${key}": dropped renderer option "${field}"`);
    }
  }
  return out;
}

/** One attachment from a renderer, rebuilt from the known fields; [] when it has no usable path. */
function rendererFileRef(item: unknown): AgentChatFileRef[] {
  if (!item || typeof item !== "object") return [];
  const entry = item as Record<string, unknown>;
  if (typeof entry.path !== "string" || !entry.path.trim()) return [];
  const ref: AgentChatFileRef = { path: entry.path };
  if (typeof entry.name === "string") ref.name = entry.name;
  if (typeof entry.mimeType === "string") ref.mimeType = entry.mimeType;
  if (typeof entry.bytes === "number" && Number.isFinite(entry.bytes)) ref.bytes = entry.bytes;
  if (entry.type === "file" || entry.type === "image") ref.type = entry.type;
  if (typeof entry.hydrate === "boolean") ref.hydrate = entry.hydrate;
  return [ref];
}
