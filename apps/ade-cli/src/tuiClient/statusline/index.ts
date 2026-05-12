import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claudeHomePath } from "../keybindings";

export type ClaudeStatusLineConfig = {
  type: string;
  command: string;
  padding: number;
  refreshIntervalSeconds: number | null;
  hideVimModeIndicator: boolean;
  source: "user" | "project" | "local";
  filePath: string;
};

export type ClaudeStatusLinePayload = {
  cwd: string;
  workspaceRoot: string;
  projectRoot: string;
  model?: {
    id?: string | null;
    displayName?: string | null;
    display_name?: string | null;
    provider?: string | null;
    fastMode?: boolean;
    supportsEffort?: boolean;
  };
  workspace?: {
    current_dir?: string;
    project_dir?: string;
    added_dirs?: string[];
    git_worktree?: string | null;
    gitBranch?: string | null;
  };
  session?: {
    id?: string | null;
    title?: string | null;
  };
  session_id?: string | null;
  session_name?: string | null;
  lane?: string | null;
  permission_mode?: string | null;
  context?: {
    percent?: number | null;
    tokenSummary?: string | null;
  };
  context_window?: {
    used?: number | null;
    total?: number | null;
    percentage?: number | null;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    total_input_tokens?: number | null;
    total_output_tokens?: number | null;
    context_window_size?: number | null;
    current_usage?: {
      input_tokens?: number | null;
      output_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    } | null;
  };
  rate_limits?: {
    reset_at?: string | null;
    remaining?: number | null;
    five_hour?: {
      used_percentage?: number | null;
      resets_at?: number | null;
    } | null;
    seven_day?: {
      used_percentage?: number | null;
      resets_at?: number | null;
    } | null;
  } | null;
  cost?: {
    total_cost_usd?: number | null;
    total_duration_ms?: number | null;
    total_api_duration_ms?: number | null;
    total_lines_added?: number | null;
    total_lines_removed?: number | null;
  };
  output_style?: {
    name?: string | null;
  };
  effort?: {
    level?: string | null;
  };
  thinking?: {
    enabled?: boolean;
  };
  vim?: {
    mode?: "NORMAL" | "INSERT" | "VISUAL" | "VISUAL LINE";
  };
  transcript_path?: string | null;
  version?: string | null;
};

function readJsonFile(filePath: string): { value: unknown | null; error: string | null } {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readClaudeStatusLineConfig(workspaceRoot: string): { config: ClaudeStatusLineConfig | null; diagnostics: string } {
  const candidates: Array<{ source: ClaudeStatusLineConfig["source"]; filePath: string }> = [
    { source: "user", filePath: claudeHomePath("settings.json") },
    { source: "project", filePath: path.join(workspaceRoot, ".claude", "settings.json") },
    { source: "local", filePath: path.join(workspaceRoot, ".claude", "settings.local.json") },
  ];
  const rows: string[] = [];
  let config: ClaudeStatusLineConfig | null = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.filePath)) {
      rows.push(`${candidate.source}: not configured (${candidate.filePath})`);
      continue;
    }
    const { value, error } = readJsonFile(candidate.filePath);
    if (error) {
      rows.push(`${candidate.source}: invalid JSON - ${error}`);
      continue;
    }
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const statusLine = record.statusLine && typeof record.statusLine === "object" && !Array.isArray(record.statusLine)
      ? record.statusLine as Record<string, unknown>
      : null;
    if (!statusLine) {
      rows.push(`${candidate.source}: no statusLine (${candidate.filePath})`);
      continue;
    }
    const type = typeof statusLine.type === "string" ? statusLine.type : "unknown";
    const command = typeof statusLine.command === "string" ? statusLine.command : "";
    const rawPadding = typeof statusLine.padding === "number" && Number.isFinite(statusLine.padding)
      ? statusLine.padding
      : 0;
    const rawRefreshInterval = typeof statusLine.refreshInterval === "number" && Number.isFinite(statusLine.refreshInterval)
      ? statusLine.refreshInterval
      : null;
    const padding = Math.max(0, Math.floor(rawPadding));
    const refreshIntervalSeconds = rawRefreshInterval == null ? null : Math.max(1, Math.floor(rawRefreshInterval));
    rows.push(`${candidate.source}: ${type}${command ? `\n  ${command}` : ""}${refreshIntervalSeconds ? `\n  refresh every ${refreshIntervalSeconds}s` : ""}`);
    if (command.trim()) {
      config = {
        type,
        command,
        padding,
        refreshIntervalSeconds,
        hideVimModeIndicator: statusLine.hideVimModeIndicator === true,
        source: candidate.source,
        filePath: candidate.filePath,
      };
    }
  }
  return { config, diagnostics: ["Claude status line config:", "", ...rows].join("\n") };
}

export async function runClaudeStatusLineCommand(
  config: ClaudeStatusLineConfig,
  payload: ClaudeStatusLinePayload,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  return await new Promise((resolve) => {
    const child = spawn(config.command, {
      cwd: payload.cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { ok: true; text: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, error: `statusLine timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, text: stdout.trimEnd() });
      } else {
        finish({ ok: false, error: (stderr || `statusLine exited with code ${code ?? "unknown"}`).trim() });
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}
