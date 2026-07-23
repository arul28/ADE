import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ADE_SESSION_STATUS_PROTOCOL_GUIDANCE } from "../../../shared/adeCliGuidance";

const TOTAL_BUDGET_BYTES = 3 * 1024;
const CLI_HELP_BUDGET = 700;
const RULES_BUDGET = 500;
const CONTROL_BUDGET = 850;
const CLOUD_BUDGET = 900;
const TRUNCATED_MARKER = "\n[truncated]";

const SECRET_RE = /[A-Za-z0-9+/=_\-]{40,}/;

export type CursorSdkRuntime = "local" | "cloud";

export interface CursorSdkSystemPromptInputs {
  runtime: CursorSdkRuntime;
  laneWorktreePath?: string;
  cliHelpDigest?: string | null;
  rulesText?: string | null;
  envInjectFlag?: string | undefined;
}

export interface CursorSdkSystemPromptResult {
  text: string;
  bytes: number;
  sections: { name: string; bytes: number; truncated: boolean }[];
}

export const CURSOR_SDK_PROMPT_INJECT_ENV = "ADE_CURSOR_PROMPT_INJECT";

export const isCursorSdkPromptInjectEnabled = (
  envValue: string | undefined,
): boolean => {
  if (envValue === undefined || envValue === null) return true;
  const v = envValue.trim().toLowerCase();
  if (v === "" || v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return false;
};

const truncateFromEnd = (
  text: string,
  budget: number,
): { value: string; truncated: boolean } => {
  if (text.length <= budget) return { value: text, truncated: false };
  const cut = Math.max(0, budget - TRUNCATED_MARKER.length);
  return { value: `${text.slice(0, cut)}${TRUNCATED_MARKER}`, truncated: true };
};

const stripSecretLines = (raw: string): string => {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (SECRET_RE.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
};

const collapseBlankLines = (raw: string): string =>
  raw.replace(/\n{3,}/g, "\n\n").trim();

const buildCloudCapabilitySection = (runtime: CursorSdkRuntime): string =>
  [
    `You're running inside the Cursor SDK via ADE (runtime: ${runtime}).`,
    "- Fresh ADE chats can be launched as Cursor Cloud agents (`Agent.create({ cloud: { repos, autoCreatePR?, workOnCurrentBranch? } })`). Once a chat has any turns ADE will not promote it to cloud — cloud chats must be kicked off cleanly.",
    "- Existing cloud chats can be mirrored into a new ADE chat session; replies still execute in cloud.",
    "- Cloud runs survive caller disconnect. `Agent.getRun(runId).cancel()` cancels them from anywhere. ADE auto-pulls artifacts produced by your run into the lane on completion.",
    "- `prUrl` and `autoCreatePR` are creation-time only; they cannot be added retroactively.",
    "- `agent.send(message, { model? })` continues a finished cloud agent in a new run. The model becomes sticky for subsequent turns.",
    "- \"Bring cloud to local\" is intentionally not supported — cloud and local stay separate by design.",
  ].join("\n");

const buildControlProtocolSection = (): string =>
  [
    "ADE control protocol — ADE renders private fenced control blocks from your assistant text and removes them from the visible transcript. Treat them as private formatting; do not explain the mechanism in user-facing replies.",
    "Visible plan: ```ade_update_plan {\"explanation\":\"...\",\"steps\":[{\"text\":\"Inspect wiring\",\"status\":\"pending\"}]}``` (close the fence).",
    "Blocking question (output only this block, then stop): ```ade_request_user_input {\"title\":\"Input requested\",\"questions\":[{\"id\":\"scope\",\"header\":\"Scope\",\"question\":\"Which scope?\",\"options\":[{\"label\":\"UI\"},{\"label\":\"Backend\"}],\"allowsFreeform\":true}]}```.",
    "Plan ready for approval: ```ade_plan_approval {\"planDescription\":\"1. Inspect\\n2. Patch\\n3. Verify\"}```.",
  ].join(" ");

const RULE_FILES = [".cursor/rules", "AGENTS.md", "CLAUDE.md"] as const;

export const readProjectRulesText = async (
  laneWorktreePath: string | undefined,
): Promise<string> => {
  if (!laneWorktreePath) return "";
  const parts: string[] = [];
  for (const rel of RULE_FILES) {
    const full = path.join(laneWorktreePath, rel);
    try {
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        let entries: string[] = [];
        try {
          entries = await fs.readdir(full);
        } catch {
          continue;
        }
        for (const name of entries.sort()) {
          if (!name.toLowerCase().endsWith(".mdc") && !name.toLowerCase().endsWith(".md")) continue;
          const sub = path.join(full, name);
          try {
            const text = await fs.readFile(sub, "utf8");
            parts.push(`# ${rel}/${name}\n${text}`);
          } catch {
            // skip
          }
        }
      } else if (stat.isFile()) {
        try {
          const text = await fs.readFile(full, "utf8");
          parts.push(`# ${rel}\n${text}`);
        } catch {
          // skip
        }
      }
    } catch {
      // missing — skip
    }
  }
  return parts.join("\n\n");
};

export const buildCursorSdkSystemPrompt = (
  inputs: CursorSdkSystemPromptInputs,
): CursorSdkSystemPromptResult => {
  if (!isCursorSdkPromptInjectEnabled(inputs.envInjectFlag)) {
    return { text: "", bytes: 0, sections: [] };
  }
  const sections: { name: string; bytes: number; truncated: boolean }[] = [];
  const blocks: string[] = [];

  const cloud = buildCloudCapabilitySection(inputs.runtime);
  const cloudT = truncateFromEnd(cloud, CLOUD_BUDGET);
  if (cloudT.value.length) {
    blocks.push(`## Cursor Cloud capability\n${cloudT.value}`);
    sections.push({ name: "cloud", bytes: cloudT.value.length, truncated: cloudT.truncated });
  }

  blocks.push(ADE_SESSION_STATUS_PROTOCOL_GUIDANCE);
  sections.push({
    name: "session-status",
    bytes: ADE_SESSION_STATUS_PROTOCOL_GUIDANCE.length,
    truncated: false,
  });

  const cli = (inputs.cliHelpDigest ?? "").trim();
  if (cli.length) {
    const cliClean = collapseBlankLines(cli);
    const cliT = truncateFromEnd(cliClean, CLI_HELP_BUDGET);
    blocks.push(
      [
        "## ADE CLI primer",
        "Lane shells have an `ade` command that drives the same project DB through the machine runtime endpoint. The `ade cursor cloud` subcommands (e.g. `agents list`, `agents create`, `agents send`, `agents cancel`) mirror the SDK surface above. Run `ade <command> --help` for full flags.",
        cliT.value,
      ].join("\n"),
    );
    sections.push({ name: "cli", bytes: cliT.value.length, truncated: cliT.truncated });
  }

  const ctrl = buildControlProtocolSection();
  const ctrlT = truncateFromEnd(ctrl, CONTROL_BUDGET);
  blocks.push(`## ADE control protocol\n${ctrlT.value}`);
  sections.push({ name: "control", bytes: ctrlT.value.length, truncated: ctrlT.truncated });

  const rulesRaw = (inputs.rulesText ?? "").trim();
  if (rulesRaw.length) {
    const cleaned = collapseBlankLines(stripSecretLines(rulesRaw));
    if (cleaned.length) {
      const rulesT = truncateFromEnd(cleaned, RULES_BUDGET);
      blocks.push(`## Project agent rules\n${rulesT.value}`);
      sections.push({ name: "rules", bytes: rulesT.value.length, truncated: rulesT.truncated });
    }
  }

  let text = blocks.join("\n\n");
  let truncatedTotal = false;
  if (text.length > TOTAL_BUDGET_BYTES) {
    const t = truncateFromEnd(text, TOTAL_BUDGET_BYTES);
    text = t.value;
    truncatedTotal = t.truncated;
  }
  if (truncatedTotal && sections.length) {
    sections[sections.length - 1] = {
      ...sections[sections.length - 1],
      truncated: true,
    };
  }
  return { text, bytes: text.length, sections };
};

let cachedDigest: { resolvedPath: string; value: string; mtimeMs: number } | null = null;

export const loadAdeCliHelpDigest = async (
  resourcesDir: string,
): Promise<string> => {
  const file = path.join(resourcesDir, "ade-cli-help.txt");
  try {
    const stat = await fs.stat(file);
    if (cachedDigest && cachedDigest.resolvedPath === file && cachedDigest.mtimeMs === stat.mtimeMs) {
      return cachedDigest.value;
    }
    const text = await fs.readFile(file, "utf8");
    cachedDigest = { resolvedPath: file, value: text, mtimeMs: stat.mtimeMs };
    return text;
  } catch {
    return "";
  }
};

export const findAdeCliHelpDigestFile = (moduleDir: string | undefined): string | null => {
  const fsSync = require("node:fs") as typeof import("node:fs");
  const candidates: string[] = [];
  if (process.resourcesPath) {
    if (process.platform === "darwin") {
      const archAsar = process.arch === "arm64" ? "app-arm64.asar" : "app-x64.asar";
      candidates.push(path.join(process.resourcesPath, `${archAsar}.unpacked`, "resources", "ade-cli-help.txt"));
    }
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "resources", "ade-cli-help.txt"));
    candidates.push(path.join(process.resourcesPath, "resources", "ade-cli-help.txt"));
  }
  candidates.push(path.resolve(process.cwd(), "resources", "ade-cli-help.txt"));
  candidates.push(path.resolve(process.cwd(), "apps", "desktop", "resources", "ade-cli-help.txt"));
  if (moduleDir) {
    for (let depth = 1; depth <= 7; depth += 1) {
      candidates.push(
        path.resolve(moduleDir, ...Array(depth).fill(".."), "resources", "ade-cli-help.txt"),
      );
      candidates.push(
        path.resolve(moduleDir, ...Array(depth).fill(".."), "apps", "desktop", "resources", "ade-cli-help.txt"),
      );
    }
  }
  for (const c of candidates) {
    try {
      if (fsSync.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return null;
};

export const __resetAdeCliHelpDigestCacheForTests = (): void => {
  cachedDigest = null;
};
