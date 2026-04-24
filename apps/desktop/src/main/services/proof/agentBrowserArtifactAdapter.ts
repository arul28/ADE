import fs from "node:fs";
import type { ComputerUseArtifactInput } from "../../../shared/types";
import { isRecord } from "../shared/utils";

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pushInput(target: ComputerUseArtifactInput[], input: ComputerUseArtifactInput | null): void {
  if (!input) return;
  if (!input.path && !input.uri && !input.text && input.json == null) return;
  target.push(input);
}

function coerceArtifactEntry(entry: unknown): ComputerUseArtifactInput | null {
  if (!isRecord(entry)) return null;
  return {
    kind: toOptionalString(entry.kind) ?? toOptionalString(entry.type),
    title: toOptionalString(entry.title) ?? toOptionalString(entry.name),
    description: toOptionalString(entry.description) ?? toOptionalString(entry.summary),
    path: toOptionalString(entry.path) ?? toOptionalString(entry.filePath),
    uri: toOptionalString(entry.uri) ?? toOptionalString(entry.url),
    text: toOptionalString(entry.text),
    json: entry.json,
    mimeType: toOptionalString(entry.mimeType) ?? toOptionalString(entry.contentType),
    rawType: toOptionalString(entry.rawType) ?? toOptionalString(entry.type),
    metadata: isRecord(entry.metadata) ? entry.metadata : null,
  };
}

export function parseAgentBrowserArtifactPayload(payload: unknown): ComputerUseArtifactInput[] {
  const inputs: ComputerUseArtifactInput[] = [];
  if (!payload) return inputs;

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      pushInput(inputs, coerceArtifactEntry(entry));
    }
    return inputs;
  }

  if (!isRecord(payload)) return inputs;

  if (Array.isArray(payload.artifacts)) {
    for (const entry of payload.artifacts) {
      pushInput(inputs, coerceArtifactEntry(entry));
    }
  }

  const directMappings: Array<[string, string, string]> = [
    ["screenshotPath", "screenshot", "Agent-browser screenshot"],
    ["imagePath", "screenshot", "Agent-browser screenshot"],
    ["videoPath", "video_recording", "Agent-browser video"],
    ["tracePath", "browser_trace", "Agent-browser trace"],
    ["consoleLogsPath", "console_logs", "Agent-browser console logs"],
    ["consoleLogPath", "console_logs", "Agent-browser console logs"],
    ["verificationPath", "browser_verification", "Agent-browser verification"],
  ];
  for (const [field, kind, title] of directMappings) {
    const pathValue = toOptionalString(payload[field]);
    if (!pathValue) continue;
    pushInput(inputs, {
      kind,
      title,
      path: pathValue,
      rawType: field,
      metadata: { sourceField: field },
    });
  }

  const directTextMappings: Array<[string, string, string]> = [
    ["consoleLogs", "console_logs", "Agent-browser console logs"],
    ["consoleLog", "console_logs", "Agent-browser console logs"],
    ["verificationText", "browser_verification", "Agent-browser verification"],
  ];
  for (const [field, kind, title] of directTextMappings) {
    const textValue = toOptionalString(payload[field]);
    if (!textValue) continue;
    pushInput(inputs, {
      kind,
      title,
      text: textValue,
      rawType: field,
      metadata: { sourceField: field },
    });
  }

  return inputs;
}

export function loadAgentBrowserArtifactPayloadFromFile(filePath: string): ComputerUseArtifactInput[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parseAgentBrowserArtifactPayload(parsed);
}
