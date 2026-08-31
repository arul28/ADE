/**
 * Where a plugin's session setup lives on disk, and how it becomes env.
 *
 * The Linear built-in re-derives its context file from `session_linear_issues`
 * every time an agent process starts, so a resume after an app restart still
 * gets `ADE_LINEAR_*`. A plugin's setup has no such backing table — it arrives
 * once, at launch — so it is persisted next to the Linear file instead, under
 * the same per-session context directory, and re-read on every env build.
 *
 * Layout, per session:
 *
 *   <contextDir>/<sessionId>/linear-issues.json   ← the built-in, untouched
 *   <contextDir>/<sessionId>/plugin/setup.json    ← the sidecar written here
 *   <contextDir>/<sessionId>/plugin/context/<name> ← the plugin's context file
 *
 * The context file sits one directory below the sidecar so a plugin cannot
 * name its file `setup.json` and overwrite the record of its own injection.
 *
 * Every function is best-effort on read and on clear — a session whose sidecar
 * is missing or corrupt launches without plugin env rather than failing to
 * launch — and strict on write, because a caller whose variables were silently
 * dropped gets an agent that is confidently missing its context.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveAdeLayout } from "../../../shared/adeLayout";
import {
  parsePluginSessionSetup,
  PLUGIN_SESSION_CONTEXT_FILE_ENV,
  PLUGIN_SESSION_SOURCE_ENV,
  type NormalizedPluginSessionSetup,
} from "../../../shared/plugins/sessionSetup";
import { isRecord } from "../../../shared/plugins/parse";
import { writeFileAtomic } from "../state/durableFile";

export type PluginSessionSetupTarget = {
  projectRoot: string;
  sessionId: string;
};

function sessionSetupDir({ projectRoot, sessionId }: PluginSessionSetupTarget): string {
  return path.join(resolveAdeLayout(projectRoot).contextDir, sessionId, "plugin");
}

function sidecarPath(target: PluginSessionSetupTarget): string {
  return path.join(sessionSetupDir(target), "setup.json");
}

function contextFileDir(target: PluginSessionSetupTarget): string {
  return path.join(sessionSetupDir(target), "context");
}

/**
 * Validate and persist one plugin's session setup, returning the environment
 * the launched agent should receive.
 *
 * Throws when the request breaks the key policy or a cap — the caller refuses
 * the launch rather than starting an agent with half of what it asked for.
 * Returns `null` when the caller asked for nothing.
 */
export function writePluginSessionSetup(args: {
  projectRoot: string;
  sessionId: string;
  setup: unknown;
  pluginId?: string | null;
  hostEnvKeys?: Iterable<string>;
  now?: string;
}): Record<string, string> | null {
  const normalized = parsePluginSessionSetup(args.setup, {
    hostEnvKeys: args.hostEnvKeys ?? Object.keys(process.env),
    ...(args.pluginId !== undefined ? { pluginId: args.pluginId } : {}),
  });
  if (!normalized) return null;

  const target = { projectRoot: args.projectRoot, sessionId: args.sessionId };
  const dir = sessionSetupDir(target);
  fs.mkdirSync(dir, { recursive: true });

  let contextFilePath: string | null = null;
  if (normalized.contextFile) {
    const contextDir = contextFileDir(target);
    fs.mkdirSync(contextDir, { recursive: true });
    // The name is a validated single segment, so join cannot escape; resolve
    // and re-check anyway, because a containment claim that is never asserted
    // is the kind that quietly stops being true.
    const candidate = path.resolve(contextDir, normalized.contextFile.name);
    if (path.dirname(candidate) !== path.resolve(contextDir)) {
      throw new Error("sessionSetup.contextFile.name must not escape the session context directory.");
    }
    writeFileAtomic(candidate, normalized.contextFile.content);
    contextFilePath = candidate;
  }

  writeFileAtomic(
    sidecarPath(target),
    `${JSON.stringify(
      {
        sessionId: args.sessionId,
        pluginId: normalized.pluginId,
        updatedAt: args.now ?? new Date().toISOString(),
        env: normalized.env,
        contextFileName: normalized.contextFile?.name ?? null,
      },
      null,
      2,
    )}\n`,
  );

  return buildEnv(normalized, contextFilePath);
}

function buildEnv(
  normalized: Pick<NormalizedPluginSessionSetup, "env" | "pluginId">,
  contextFilePath: string | null,
): Record<string, string> {
  return {
    ...normalized.env,
    ...(contextFilePath ? { [PLUGIN_SESSION_CONTEXT_FILE_ENV]: contextFilePath } : {}),
    ...(normalized.pluginId ? { [PLUGIN_SESSION_SOURCE_ENV]: normalized.pluginId } : {}),
  };
}

/**
 * The env a previously stored setup should inject now, or `null` when this
 * session has none. Read on every agent process start, so a resumed session
 * keeps the variables it launched with.
 *
 * Re-validated on read: the sidecar is a file on disk, and a file that has been
 * edited must not be able to introduce a key the live policy would refuse.
 */
export function readPluginSessionSetupEnv(
  target: PluginSessionSetupTarget,
): Record<string, string> | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(fs.readFileSync(sidecarPath(target), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;

  let storedEnv: Record<string, string> = {};
  try {
    storedEnv = parsePluginSessionSetup({ env: decoded.env }, {
      hostEnvKeys: Object.keys(process.env),
    })?.env ?? {};
  } catch {
    // An edited sidecar that now names a refused key contributes nothing; the
    // context file below may still be legitimate.
    storedEnv = {};
  }

  const contextFileName = typeof decoded.contextFileName === "string" ? decoded.contextFileName : "";
  let contextFilePath: string | null = null;
  if (contextFileName) {
    const dir = path.resolve(contextFileDir(target));
    const candidate = path.resolve(dir, contextFileName);
    if (path.dirname(candidate) === dir && fs.existsSync(candidate)) contextFilePath = candidate;
  }

  const pluginId = typeof decoded.pluginId === "string" && decoded.pluginId.trim()
    ? decoded.pluginId.trim()
    : null;
  const env = buildEnv({ env: storedEnv, pluginId }, contextFilePath);
  return Object.keys(env).length ? env : null;
}

/**
 * Drop a session's stored setup and its context file. Called when the session
 * is deleted, so an injected secret does not outlive the session that carried
 * it. Best-effort: a directory that is already gone is the goal state.
 */
export function clearPluginSessionSetup(target: PluginSessionSetupTarget): void {
  try {
    fs.rmSync(sessionSetupDir(target), { recursive: true, force: true });
  } catch {
    // Best-effort, same as the Linear context file's own stale-file removal.
  }
}

/**
 * The subset of a plugin env that may be spread over a host-built environment.
 *
 * The key policy already makes shadowing impossible by construction; this is
 * the second lock on the same door, applied at the moment of merge, so a caller
 * that reaches the store with a host env the validator never saw still cannot
 * have a host variable replaced. Keys are compared upper-cased because a
 * Windows environment block is case-insensitive.
 */
export function filterPluginSessionEnv(
  hostEnv: Record<string, string | undefined>,
  pluginEnv: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!pluginEnv) return {};
  const taken = new Set(Object.keys(hostEnv).map((key) => key.toUpperCase()));
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(pluginEnv)) {
    if (taken.has(key.toUpperCase())) continue;
    safe[key] = value;
  }
  return safe;
}
