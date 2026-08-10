import type { AgentChatEvent } from "./types/chat";

/**
 * One compaction policy for heavy chat-event payloads, shared by the two
 * consumers that must never disagree: the stored transcript and the mobile/web
 * sync wire.
 *
 * They used to be separate implementations with separate cap tables, and they
 * drifted exactly the way duplicated policy does. `tool_result.structured` was
 * added to the event and added to neither table, so on a real 8 MB transcript
 * it grew to 4.53 MB — 56.6% of the whole file, and ten times larger than
 * `result`, the field that IS capped. The wire was worse still: it applied only
 * inline-image redaction, so the same event went out multi-megabyte live and
 * came back small after reconnect hydration.
 *
 * Keeping both paths in one module means a new heavy field cannot be capped on
 * one side and forgotten on the other.
 */

const STORED_COMMAND_OUTPUT_RUNNING_MAX_BYTES = 4 * 1024;
const STORED_COMMAND_OUTPUT_COMPLETED_MAX_BYTES = 16 * 1024;
const STORED_COMMAND_OUTPUT_FAILED_MAX_BYTES = 64 * 1024;
const STORED_TOOL_RESULT_MAX_BYTES = 16 * 1024;
const STORED_TOOL_RESULT_FAILED_MAX_BYTES = 64 * 1024;
// `structured` is the provider's raw payload. Everything ADE actually uses from
// it (grep totals, bash timeout/cwd hints, subagent enrichment) is projected
// into typed fields on the same event at construction time, so past that point
// it is debug material only — kept, but bounded like every other heavy field.
const STORED_TOOL_RESULT_STRUCTURED_MAX_BYTES = 8 * 1024;
const STORED_FILE_DIFF_MAX_BYTES = 32 * 1024;
const STORED_REASONING_MAX_BYTES = 8 * 1024;
const STORED_INLINE_IMAGE_DATA_URL_MAX_BYTES = 64 * 1024;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const inlineImageDataUrlBytes = (value: string | null | undefined): number | null => {
  if (!value || !/^data:image\//i.test(value.trim())) return null;
  return utf8Bytes(value);
};

const redactStoredInlineImageDataUrls = (
  value: unknown,
): { value: unknown; omittedBytes: number; changed: boolean } => {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): { value: unknown; omittedBytes: number; changed: boolean } => {
    if (typeof candidate === "string") {
      const bytes = inlineImageDataUrlBytes(candidate);
      if (bytes == null || bytes <= STORED_INLINE_IMAGE_DATA_URL_MAX_BYTES) {
        return { value: candidate, omittedBytes: 0, changed: false };
      }
      return {
        value: `[ADE] Inline image was left out (${bytes} bytes).`,
        omittedBytes: bytes,
        changed: true,
      };
    }
    if (!candidate || typeof candidate !== "object") {
      return { value: candidate, omittedBytes: 0, changed: false };
    }
    if (depth >= 32) {
      return {
        value: "[ADE] Deeply nested content was left out.",
        omittedBytes: 0,
        changed: true,
      };
    }
    if (seen.has(candidate)) {
      return { value: "[Circular]", omittedBytes: 0, changed: true };
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      let omittedBytes = 0;
      let changed = false;
      const next = candidate.map((entry) => {
        const result = visit(entry, depth + 1);
        omittedBytes += result.omittedBytes;
        changed ||= result.changed;
        return result.value;
      });
      seen.delete(candidate);
      return { value: changed ? next : candidate, omittedBytes, changed };
    }
    let omittedBytes = 0;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(candidate)) {
      const result = visit(entry, depth + 1);
      next[key] = result.value;
      omittedBytes += result.omittedBytes;
      changed ||= result.changed;
    }
    seen.delete(candidate);
    return { value: changed ? next : candidate, omittedBytes, changed };
  };
  return visit(value, 0);
};

const sliceUtf8FromStart = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return value.slice(0, low);
};

const sliceUtf8FromEnd = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(value.length - mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return value.slice(value.length - low);
};

const compactStoredTextPayload = (
  label: string,
  text: string,
  maxBytes: number,
): { text: string; originalBytes: number; omittedBytes: number } | null => {
  const originalBytes = utf8Bytes(text);
  if (originalBytes <= maxBytes) return null;

  const prefix = [
    `[ADE] Large ${label} was shortened to keep this chat fast.`,
    `Original size: ${originalBytes} bytes.`,
    "",
    "----- BEGIN FIRST PREVIEW -----",
    "",
  ].join("\n");
  const suffix = [
    "",
    "----- END LAST PREVIEW -----",
  ].join("\n");
  const overheadBytes = utf8Bytes(prefix) + utf8Bytes(suffix) + 512;
  const previewBudgetBytes = Math.max(512, maxBytes - overheadBytes);
  const halfBudgetBytes = Math.max(256, Math.floor(previewBudgetBytes / 2));
  const head = sliceUtf8FromStart(text, halfBudgetBytes);
  const tail = sliceUtf8FromEnd(text, Math.max(256, previewBudgetBytes - utf8Bytes(head)));
  const omittedBytes = Math.max(0, originalBytes - utf8Bytes(head) - utf8Bytes(tail));
  const omitted = [
    "",
    "----- END FIRST PREVIEW -----",
    "",
    `[ADE] ${omittedBytes} bytes were left out.`,
    "",
    "----- BEGIN LAST PREVIEW -----",
    "",
  ].join("\n");
  return {
    text: `${prefix}${head}${omitted}${tail}${suffix}`,
    originalBytes,
    omittedBytes,
  };
};

/**
 * Bound the running-command output the chat runtimes accumulate in memory.
 *
 * Exported as a whole operation rather than as its cap: callers that assembled
 * the label and the byte budget themselves were a third and fourth copy of a
 * pairing this module exists to own, which is exactly how the two cap tables
 * drifted apart in the first place.
 */
export const compactRunningCommandOutput = (
  text: string,
): { text: string; originalBytes: number; omittedBytes: number } | null =>
  compactStoredTextPayload("command output", text, STORED_COMMAND_OUTPUT_RUNNING_MAX_BYTES);

/**
 * Recognize this module's own wrapper by its shape.
 *
 * Deliberately not a marker key: every surface that shows an object-shaped tool
 * result renders it as a JSON dump (desktop card and collapsed preview, the TUI
 * one-liner, the iOS Result block), so an added key becomes the first line the
 * user reads. Shape detection also recognizes wrappers already written to disk
 * by builds that predate this check, which a marker never could.
 */
const isCompactedPayloadWrapper = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.summary === "string"
    && candidate.summary.startsWith("[ADE] Large ")
    && typeof candidate.preview === "string"
    && typeof candidate.originalBytes === "number"
    && typeof candidate.omittedBytes === "number";
};

const stringifyPayloadForCompaction = (
  value: unknown,
): { text: string; structured: boolean; serializable: boolean } => {
  if (typeof value === "string") return { text: value, structured: false, serializable: true };
  try {
    const json = JSON.stringify(value, null, 2);
    if (typeof json === "string") return { text: json, structured: true, serializable: true };
    return { text: String(value), structured: false, serializable: true };
  } catch {
    // A circular reference or a BigInt anywhere in the payload lands here, and
    // `String(value)` is "[object Object]" — 15 bytes, under every cap. Reporting
    // that as the size let the ORIGINAL unbounded object through untouched,
    // which is the one case the cap exists for.
    return { text: String(value), structured: false, serializable: false };
  }
};

const compactStoredUnknownPayload = (
  label: string,
  value: unknown,
  maxBytes: number,
): { value: unknown; originalBytes: number; omittedBytes: number } | null => {
  // Already ours: leave it exactly as it is. Compaction has to be idempotent
  // because the wire applies it to events that came off disk already compacted
  // (hydration and the replay ring). Re-wrapping is not a harmless no-op — the
  // wrapper's newline-dense `preview` re-serializes with JSON escaping and comes
  // out BIGGER than the cap, so each pass grew the payload (16.7 KB → 17.1 KB →
  // 18.0 KB) while overwriting `originalBytes` with the previous pass's size,
  // destroying the real one.
  // Size-bounded: recognizing our own wrapper must not become an escape hatch a
  // provider payload can trip by coincidence. A genuine wrapper measures a few
  // percent over its cap, so anything past 2x is not one and gets compacted
  // normally — the pass after that then sees a real wrapper and skips it.
  if (isCompactedPayloadWrapper(value)
    && utf8Bytes(stringifyPayloadForCompaction(value).text) <= maxBytes * 2) {
    return null;
  }
  const serialized = stringifyPayloadForCompaction(value);
  if (!serialized.serializable) {
    // Unmeasurable is not "small". Substitute a bounded placeholder rather than
    // storing and transmitting a payload no cap could see.
    const summary = `[ADE] Large ${label} could not be measured and was left out.`;
    return {
      value: { summary, originalBytes: 0, omittedBytes: 0, preview: serialized.text.slice(0, 256) },
      originalBytes: 0,
      omittedBytes: 0,
    };
  }
  const compacted = compactStoredTextPayload(label, serialized.text, maxBytes);
  if (!compacted) return null;
  if (!serialized.structured) {
    return { value: compacted.text, originalBytes: compacted.originalBytes, omittedBytes: compacted.omittedBytes };
  }
  return {
    value: {
      summary: `[ADE] Large ${label} was shortened to keep this chat fast.`,
      originalBytes: compacted.originalBytes,
      omittedBytes: compacted.omittedBytes,
      preview: compacted.text,
    },
    originalBytes: compacted.originalBytes,
    omittedBytes: compacted.omittedBytes,
  };
};

const compactStructuredForStorage = (
  value: unknown,
): { value: unknown; changed: boolean } => {
  if (value === undefined) return { value: undefined, changed: false };
  const redacted = redactStoredInlineImageDataUrls(value);
  const compacted = compactStoredUnknownPayload(
    "tool result detail",
    redacted.value,
    STORED_TOOL_RESULT_STRUCTURED_MAX_BYTES,
  );
  if (!redacted.changed && !compacted) return { value, changed: false };
  return { value: compacted?.value ?? redacted.value, changed: true };
};

export const compactChatEventForStorage = (event: AgentChatEvent): AgentChatEvent => {
  if (event.type === "command") {
    const maxBytes = event.status === "failed"
      ? STORED_COMMAND_OUTPUT_FAILED_MAX_BYTES
      : event.status === "running"
        ? STORED_COMMAND_OUTPUT_RUNNING_MAX_BYTES
        : STORED_COMMAND_OUTPUT_COMPLETED_MAX_BYTES;
    const compacted = compactStoredTextPayload("command output", event.output, maxBytes);
    return compacted
      ? {
          ...event,
          output: compacted.text,
          outputOriginalBytes: compacted.originalBytes,
          outputOmittedBytes: compacted.omittedBytes,
        }
      : event;
  }

  if (event.type === "tool_result") {
    const maxBytes = event.status === "failed" || event.status === "interrupted"
      ? STORED_TOOL_RESULT_FAILED_MAX_BYTES
      : STORED_TOOL_RESULT_MAX_BYTES;
    const redacted = redactStoredInlineImageDataUrls(event.result);
    const compacted = compactStoredUnknownPayload("tool result", redacted.value, maxBytes);
    const structured = compactStructuredForStorage(event.structured);
    if (!redacted.changed && !compacted && !structured.changed) return event;
    // Only restate the result accounting when the result actually changed.
    // Writing it unconditionally zeroed `resultOriginalBytes` on an event whose
    // result was untouched and only `structured` was capped — throwing away a
    // real prior measurement and reporting 0 bytes for a payload that had been
    // shortened from megabytes.
    const resultChanged = redacted.changed || compacted != null;
    const originalBytes = redacted.changed
      ? utf8Bytes(stringifyPayloadForCompaction(event.result).text)
      : compacted?.originalBytes ?? 0;
    return {
      ...event,
      ...(resultChanged
        ? {
            result: compacted?.value ?? redacted.value,
            resultOriginalBytes: originalBytes,
            resultOmittedBytes: redacted.omittedBytes + (compacted?.omittedBytes ?? 0),
          }
        : {}),
      ...(structured.changed ? { structured: structured.value } : {}),
    };
  }

  if (event.type === "file_change") {
    const compacted = compactStoredTextPayload("file diff", event.diff, STORED_FILE_DIFF_MAX_BYTES);
    return compacted
      ? {
          ...event,
          diff: compacted.text,
          diffOriginalBytes: compacted.originalBytes,
          diffOmittedBytes: compacted.omittedBytes,
        }
      : event;
  }

  if (event.type === "reasoning") {
    const compacted = compactStoredTextPayload("reasoning", event.text, STORED_REASONING_MAX_BYTES);
    return compacted
      ? {
          ...event,
          text: compacted.text,
          textOriginalBytes: compacted.originalBytes,
          textOmittedBytes: compacted.omittedBytes,
        }
      : event;
  }

  if (event.type === "codex_image_generation") {
    const resultBytes = inlineImageDataUrlBytes(event.result);
    const savedPathIsInline = inlineImageDataUrlBytes(event.savedPath) != null;
    if (resultBytes != null && resultBytes > STORED_INLINE_IMAGE_DATA_URL_MAX_BYTES) {
      return {
        ...event,
        result: null,
        ...(savedPathIsInline ? { savedPath: null } : {}),
        resultOriginalBytes: resultBytes,
        resultOmittedBytes: resultBytes,
      };
    }
    return savedPathIsInline ? { ...event, savedPath: null } : event;
  }

  if (event.type === "codex_image_view") {
    const urlBytes = inlineImageDataUrlBytes(event.url);
    const pathIsInline = inlineImageDataUrlBytes(event.path) != null;
    if (urlBytes != null && urlBytes > STORED_INLINE_IMAGE_DATA_URL_MAX_BYTES) {
      return {
        ...event,
        url: null,
        ...(pathIsInline ? { path: null } : {}),
        urlOriginalBytes: urlBytes,
        urlOmittedBytes: urlBytes,
      };
    }
    return pathIsInline ? { ...event, path: null } : event;
  }

  return event;
};

/**
 * The event as phones and web clients should receive it.
 *
 * Storage compaction first, so a live push and the same event re-read after
 * reconnect hydration are byte-identical — they were not, and an event visibly
 * shrinking on reconnect is a bug users could see.
 *
 * Then drop the fields no client reads. `structured` is not a coding key in the
 * iOS decoder at all and has no renderer, TUI, or web consumer; `toolResultMeta`
 * is written once and never read anywhere. Sending them costs the phone a
 * download and a JSON parse to produce something it immediately discards.
 *
 * Removing a field no client decodes is backward-compatible by construction, so
 * this needs no capability gate: an older build cannot miss a value it never
 * read. Anything that ADDS or reshapes a field must be gated.
 */
export function compactChatEventForWire(event: AgentChatEvent): AgentChatEvent {
  const compacted = compactChatEventForStorage(event);
  if (compacted.type !== "tool_result") return compacted;
  if (compacted.structured === undefined && compacted.toolResultMeta === undefined) {
    return compacted;
  }
  const { structured: _structured, toolResultMeta: _toolResultMeta, ...wire } = compacted;
  return wire;
}
