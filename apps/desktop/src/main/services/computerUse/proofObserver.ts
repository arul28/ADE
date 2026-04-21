/**
 * Passive proof observer for the ADE chat system.
 *
 * Watches tool_result events from the agent chat stream and automatically
 * ingests screenshot/image/video/trace artifacts into the artifact broker
 * so they appear in the proof drawer without the agent explicitly calling
 * ingest_computer_use_artifacts.
 */

import { fileURLToPath } from "node:url";
import type { AgentChatEvent } from "../../../shared/types/chat";
import type {
  ComputerUseArtifactInput,
  ComputerUseArtifactKind,
  ComputerUseBackendDescriptor,
} from "../../../shared/types/computerUseArtifacts";
import type { ComputerUseArtifactBrokerService } from "./computerUseArtifactBrokerService";

// ---------------------------------------------------------------------------
// Layer 1: Known tool name sets
// ---------------------------------------------------------------------------

/** Ghost OS perception tools that produce visual artifacts. */
const GHOST_ARTIFACT_TOOLS = new Set([
  "ghost_screenshot",
  "ghost_annotate",
  "ghost_ground",
  "ghost_parse_screen",
]);

// ---------------------------------------------------------------------------
// Layer 2: Content scanning patterns
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|webp|gif|bmp|tiff|svg)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi|mkv)$/i;
const TRACE_EXTENSIONS = /\.(zip|trace)$/i;
const LOG_EXTENSIONS = /\.(log|txt|ndjson|jsonl)$/i;
const ARTIFACT_FIELD_NAMES =
  /screenshot|image|proof|recording|video|capture|snapshot|trace|console|log/i;
const EMBEDDED_ARTIFACT_CONTEXT_FIELDS = /stdout|stderr|output|result|response|trace|console|log/i;
const TEXTUAL_CONTENT_FIELD_NAMES = /body|comment|content|text|markdown|description|summary|headline|title|html|note/i;
const TRACE_FIELD_NAMES = /trace/i;
const LOG_FIELD_NAMES = /console|log/i;
const BASE64_IMAGE_URI = /^data:image\/[a-z+]+;base64,/i;
const BASE64_VIDEO_URI = /^data:video\/[a-z0-9.+-]+;base64,/i;
const EMBEDDED_ARTIFACT_PATTERN =
  /(?:file:\/\/\/[^\s"'`]+|https?:\/\/[^\s"'`]+|\/[^\s"'`]+)\.(?:png|jpe?g|webp|gif|bmp|tiff|svg|mp4|webm|mov|avi|mkv|zip|trace|log|txt|ndjson|jsonl)\b/gi;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function inferKindFromString(
  value: string,
  fieldName: string | null = null,
): ComputerUseArtifactKind | null {
  if (BASE64_IMAGE_URI.test(value)) return "screenshot";
  if (BASE64_VIDEO_URI.test(value)) return "video_recording";
  if (TRACE_EXTENSIONS.test(value) && (TRACE_FIELD_NAMES.test(fieldName ?? "") || /trace/i.test(value))) {
    return "browser_trace";
  }
  if (LOG_EXTENSIONS.test(value) && (LOG_FIELD_NAMES.test(fieldName ?? "") || /console|log/i.test(value))) {
    return "console_logs";
  }
  if (IMAGE_EXTENSIONS.test(value)) return "screenshot";
  if (VIDEO_EXTENSIONS.test(value)) return "video_recording";
  return null;
}

function inferMimeType(value: string): string | null {
  const base64Match = value.match(/^data:(image\/[a-z+]+);base64,/i);
  if (base64Match) return base64Match[1];
  const base64VideoMatch = value.match(/^data:(video\/[a-z0-9.+-]+);base64,/i);
  if (base64VideoMatch) return base64VideoMatch[1];

  const extMatch = value.match(/\.([a-z0-9]+)$/i);
  if (!extMatch) return null;
  const ext = extMatch[1].toLowerCase();

  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    zip: "application/zip",
    trace: "application/octet-stream",
    log: "text/plain",
    txt: "text/plain",
    ndjson: "application/x-ndjson",
    jsonl: "application/x-ndjson",
  };
  return mimeMap[ext] ?? null;
}

function inferBackendName(toolName: string): string {
  const proxiedExternalMatch = /^ext\.([^.]+)\./.exec(toolName);
  if (proxiedExternalMatch?.[1]) return proxiedExternalMatch[1];
  if (toolName.startsWith("ghost_")) {
    return "ghost-os";
  }
  if (toolName.startsWith("functions.")) return "functions";
  if (toolName.startsWith("multi_tool_use.")) return "multi_tool_use";
  if (toolName.startsWith("web.")) return "web";
  const dottedNamespace = /^([A-Za-z0-9_-]+)\./.exec(toolName);
  if (dottedNamespace?.[1]) return dottedNamespace[1];
  return "chat-tool";
}

function inferBackendDescriptor(toolName: string): ComputerUseBackendDescriptor {
  return {
    style: "external_cli",
    name: inferBackendName(toolName),
    toolName,
  };
}

function buildTitle(toolName: string, kind: ComputerUseArtifactKind): string {
  const kindLabel = kind.replace(/_/g, " ");
  const shortTool = toolName.replace(/^ext\./, "");
  return `${kindLabel[0].toUpperCase()}${kindLabel.slice(1)} from ${shortTool}`;
}

/**
 * Describes a single artifact candidate discovered inside a tool result.
 */
type ArtifactCandidate = {
  kind: ComputerUseArtifactKind;
  uri: string | null;
  path: string | null;
  mimeType: string | null;
  fieldName: string | null;
};

function resolveArtifactLocation(value: string): { uri: string | null; path: string | null } {
  if (BASE64_IMAGE_URI.test(value) || BASE64_VIDEO_URI.test(value) || /^https?:\/\//i.test(value)) {
    return { uri: value, path: null };
  }
  if (value.startsWith("file://")) {
    try {
      return { uri: null, path: fileURLToPath(value) };
    } catch {
      const fallback = decodeURIComponent(value.replace(/^file:\/\//i, ""));
      return { uri: null, path: fallback.startsWith("/") ? fallback : `/${fallback}` };
    }
  }
  return { uri: null, path: value };
}

function buildCandidateFromString(
  value: string,
  fieldName: string | null,
): ArtifactCandidate | null {
  const kind = inferKindFromString(value, fieldName);
  if (!kind) return null;
  const location = resolveArtifactLocation(value);
  return {
    kind,
    uri: location.uri,
    path: location.path,
    mimeType: inferMimeType(value),
    fieldName,
  };
}

function looksLikeDirectArtifactLocator(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.length) return false;
  if (BASE64_IMAGE_URI.test(trimmed) || BASE64_VIDEO_URI.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("file://")) return true;
  if (trimmed.startsWith("/")) return !/\s/.test(trimmed);
  return !/\s/.test(trimmed);
}

// ---------------------------------------------------------------------------
// Layer 1: Extract artifacts from known Ghost OS perception tools
// ---------------------------------------------------------------------------

function extractFromGhostPerceptionResult(
  result: unknown,
): ArtifactCandidate[] {
  if (!isRecord(result)) return [];

  const candidates: ArtifactCandidate[] = [];

  // ghost_screenshot / ghost_annotate typically return { path, ... } or { image, ... }
  const pathValue =
    typeof result.path === "string" ? result.path :
    typeof result.screenshot_path === "string" ? result.screenshot_path :
    null;

  if (pathValue) {
    const candidate = buildCandidateFromString(pathValue, "path");
    if (candidate) candidates.push(candidate);
  }

  const uriValue =
    typeof result.uri === "string" ? result.uri :
    typeof result.url === "string" ? result.url :
    null;

  if (uriValue && !pathValue) {
    const candidate = buildCandidateFromString(uriValue, "uri");
    if (candidate) {
      candidates.push(candidate);
    } else {
      candidates.push({
        kind: "screenshot",
        uri: uriValue,
        path: null,
        mimeType: inferMimeType(uriValue),
        fieldName: "uri",
      });
    }
  }

  const imageValue = typeof result.image === "string" ? result.image : null;
  if (imageValue && candidates.length === 0) {
    const candidate = buildCandidateFromString(imageValue, "image");
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Layer 2: Recursive content scanner for arbitrary tool results
// ---------------------------------------------------------------------------

function scanResultForArtifacts(
  value: unknown,
  fieldName: string | null,
  depth: number,
  collected: ArtifactCandidate[],
  visited: WeakSet<object>,
): void {
  // Guard against excessive recursion
  if (depth > 10) return;

  if (typeof value === "string") {
    const fieldLooksTextual = fieldName != null
      && TEXTUAL_CONTENT_FIELD_NAMES.test(fieldName)
      && !ARTIFACT_FIELD_NAMES.test(fieldName);
    if (fieldLooksTextual) return;

    // Check for base64 data URIs
    const exactCandidate = looksLikeDirectArtifactLocator(value)
      ? buildCandidateFromString(value.trim(), fieldName)
      : null;
    if (exactCandidate) {
      collected.push(exactCandidate);
      return;
    }

    const allowEmbeddedMatches = fieldName == null
      || ARTIFACT_FIELD_NAMES.test(fieldName)
      || EMBEDDED_ARTIFACT_CONTEXT_FIELDS.test(fieldName);
    const embeddedMatches = allowEmbeddedMatches
      ? (value.match(EMBEDDED_ARTIFACT_PATTERN) ?? [])
      : [];
    if (embeddedMatches.length > 0) {
      for (const match of embeddedMatches) {
        const embeddedCandidate = buildCandidateFromString(match, fieldName);
        if (embeddedCandidate) {
          collected.push(embeddedCandidate);
        }
      }
      return;
    }

    // If the field name itself hints at an artifact, try to infer kind
    if (fieldName && ARTIFACT_FIELD_NAMES.test(fieldName) && value.length > 0) {
      // Only capture if the value looks like a path or URI (not arbitrary text)
      if (value.startsWith("/") || value.startsWith("file://") || /^https?:\/\//i.test(value)) {
        const inferredKind: ComputerUseArtifactKind =
          TRACE_FIELD_NAMES.test(fieldName)
            ? "browser_trace"
            : LOG_FIELD_NAMES.test(fieldName)
              ? "console_logs"
              : /video|recording/i.test(fieldName)
                ? "video_recording"
                : "screenshot";
        const location = resolveArtifactLocation(value);
        collected.push({
          kind: inferredKind,
          uri: location.uri,
          path: location.path,
          mimeType: inferMimeType(value),
          fieldName,
        });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    if (visited.has(value)) return;
    visited.add(value);
    for (let i = 0; i < value.length; i++) {
      scanResultForArtifacts(value[i], fieldName, depth + 1, collected, visited);
    }
    return;
  }

  if (isRecord(value)) {
    if (visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      scanResultForArtifacts(child, key, depth + 1, collected, visited);
    }
  }
}

// ---------------------------------------------------------------------------
// De-duplicate candidates by URI/path
// ---------------------------------------------------------------------------

function deduplicateCandidates(
  candidates: ArtifactCandidate[],
): ArtifactCandidate[] {
  const seen = new Set<string>();
  const unique: ArtifactCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.uri ?? candidate.path ?? "";
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Build ingestion inputs from candidates
// ---------------------------------------------------------------------------

function candidateToInput(
  candidate: ArtifactCandidate,
  toolName: string,
): ComputerUseArtifactInput {
  return {
    kind: candidate.kind,
    title: buildTitle(toolName, candidate.kind),
    path: candidate.path,
    uri: candidate.uri,
    mimeType: candidate.mimeType,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createProofObserver(args: {
  broker: ComputerUseArtifactBrokerService;
}): {
  observe(event: AgentChatEvent, sessionId: string): void;
  clearSession(sessionId: string): void;
} {
  const { broker } = args;

  /** Track ingested itemIds per session for de-duplication. */
  const ingestedBySession = new Map<string, Set<string>>();

  function getSessionSet(sessionId: string): Set<string> {
    let set = ingestedBySession.get(sessionId);
    if (!set) {
      set = new Set<string>();
      ingestedBySession.set(sessionId, set);
    }
    return set;
  }

  function observe(event: AgentChatEvent, sessionId: string): void {
    try {
      // Only process tool_result events
      if (event.type !== "tool_result") return;

      // Skip preliminary / running results
      if (event.status === "running") return;

      // De-duplication by itemId
      const sessionSet = getSessionSet(sessionId);
      if (sessionSet.has(event.itemId)) return;

      const toolName = event.tool;
      const result = event.result;

      let candidates: ArtifactCandidate[] = [];

      // Layer 1: Known Ghost OS perception tools (fast path)
      if (GHOST_ARTIFACT_TOOLS.has(toolName)) {
        candidates = extractFromGhostPerceptionResult(result);
      }

      // Layer 2: Content scanning catch-all
      // For known action tools, we still run the scanner -- an action tool
      // might return a post-action screenshot we should capture.
      // For perception tools, the scanner is a second pass to catch anything
      // the fast path missed.
      if (candidates.length === 0 || !GHOST_ARTIFACT_TOOLS.has(toolName)) {
        const scanned: ArtifactCandidate[] = [];
        const visited = new WeakSet<object>();
        scanResultForArtifacts(result, null, 0, scanned, visited);
        candidates = candidates.concat(scanned);
      }

      // De-duplicate by URI/path across all collected candidates
      candidates = deduplicateCandidates(candidates);

      if (candidates.length === 0) return;

      // Build ingestion inputs
      const inputs: ComputerUseArtifactInput[] = candidates.map((candidate) =>
        candidateToInput(candidate, toolName),
      );

      // Build backend descriptor
      const backend: ComputerUseBackendDescriptor = inferBackendDescriptor(toolName);

      // Ingest into the broker
      broker.ingest({
        backend,
        inputs,
        owners: [
          { kind: "chat_session", id: sessionId, relation: "produced_by" },
        ],
      });

      // Mark this itemId as ingested
      sessionSet.add(event.itemId);
    } catch (error) {
      // The observer must never crash the event pipeline.
      // Log the error but swallow it.
      console.error(
        "[proofObserver] Failed to process tool_result event:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function clearSession(sessionId: string): void {
    ingestedBySession.delete(sessionId);
  }

  return { observe, clearSession };
}
