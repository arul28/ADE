import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { resolveToolsRootLayout, toolUsageRoot } from "./paths";
import { warnTools } from "./toolsLog";

/**
 * When each pinned tool last ran on this machine, kept beside the tools cache.
 *
 * "Installed" is not "used": a tool a status read once downloaded, or one an
 * old build fetched, would otherwise count as a tool the machine uses and be
 * fetched again at every pin change. This file is what counts instead: the
 * startup fetch keeps only recently used tools current, and a budgeted cache
 * (`systemCache.ts`) removes the least recently used first.
 *
 * Written only from a real use (`pinnedToolDownload`, which every spawn site
 * calls just before it runs a tool), at most once per tool per
 * {@link USE_WRITE_INTERVAL_MS} in a process, tmp-file + rename. Two processes
 * racing a write can lose one update; the next use writes it again.
 */
const USAGE_FILE = ".last-used.json";
const USAGE_SCHEMA_VERSION = 1;
/** One write per tool per process in this window; a chat that respawns never writes in a loop. */
const USE_WRITE_INTERVAL_MS = 10 * 60_000;

const lastWrittenAt = new Map<string, number>();
let writeChain: Promise<void> = Promise.resolve();

function usagePath(toolsRoot: string): string {
  return path.join(toolsRoot, USAGE_FILE);
}

/** Tool name -> epoch ms it last ran. Missing or unreadable reads as none. Sync: two small reads at most. */
export function readToolUsage(toolsRoot: string): Record<string, number> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(usagePath(toolsRoot), "utf8"));
  } catch {
    return {};
  }
  const tools = (raw as { tools?: unknown } | null)?.tools;
  const out: Record<string, number> = {};
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return out;
  for (const [name, at] of Object.entries(tools)) {
    if (typeof at === "number" && Number.isFinite(at) && /^[a-z0-9][a-z0-9._-]*$/.test(name)) out[name] = at;
  }
  return out;
}

/** Record that `name` runs now. Never throws, never blocks the caller. */
export function noteToolUse(name: string, toolsRoot: string, now = Date.now()): void {
  const key = `${toolsRoot}\0${name}`;
  const previous = lastWrittenAt.get(key);
  if (previous !== undefined && now - previous < USE_WRITE_INTERVAL_MS) return;
  lastWrittenAt.set(key, now);
  writeChain = writeChain.then(async () => {
    try {
      const usage = readToolUsage(toolsRoot);
      usage[name] = now;
      await fsp.mkdir(toolsRoot, { recursive: true });
      const target = usagePath(toolsRoot);
      const temp = `${target}.${process.pid}.${now}.tmp`;
      const sorted = Object.fromEntries(Object.entries(usage).sort(([left], [right]) => left.localeCompare(right)));
      await fsp.writeFile(temp, `${JSON.stringify({ schemaVersion: USAGE_SCHEMA_VERSION, tools: sorted }, null, 2)}\n`, "utf8");
      await fsp.rename(temp, target).catch(async (error) => {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      });
    } catch (error) {
      // Best effort: a lost record only means the next use writes it.
      lastWrittenAt.delete(key);
      warnTools("tools.usage_write_failed", { tool: name, code: (error as NodeJS.ErrnoException | null)?.code ?? "unknown" });
    }
  });
}

/** The usage root for a tools context: its `toolsRoot` when given (tests), else this machine's (`toolUsageRoot`). */
export function toolUsageRootFor(context: { toolsRoot?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): string {
  if (context.toolsRoot) return path.resolve(context.toolsRoot);
  return toolUsageRoot(resolveToolsRootLayout(context.env ?? process.env, context.platform ?? process.platform));
}
