import {
  type ToolProgress,
  type ToolResolution,
  ensureTools,
  gcTools,
  isToolError,
  listPinnedTools,
  resolveMachineToolsRoot,
  tryResolveTool,
} from "../services/tools";

export class ToolsUsageError extends Error {}

export type ToolsCommandDeps = {
  env?: NodeJS.ProcessEnv;
  /**
   * Stream per-phase progress. Set from the global `--text` flag: under the
   * default `--json` mode the payload is the whole output and a progress
   * stream would only interleave noise into a machine-read stdout.
   */
  textProgress?: boolean;
  /** Progress sink. stderr so `--json` stdout stays a single clean document. */
  write?: (line: string) => void;
  ensure?: typeof ensureTools;
  gc?: typeof gcTools;
  resolve?: typeof tryResolveTool;
  listPinned?: typeof listPinnedTools;
};

type ToolStatusRow = {
  tool: string;
  installed: boolean;
  packageName: string | null;
  version: string | null;
  entryPath: string | null;
};

function describeProgress(progress: ToolProgress): string {
  const label = `${progress.tool} (${progress.packageName}@${progress.version})`;
  switch (progress.phase) {
    case "cached":
      return `${label} already installed`;
    case "waiting":
      return `${label} waiting for another ADE process to finish installing`;
    case "downloading": {
      const { receivedBytes, totalBytes } = progress;
      if (typeof receivedBytes !== "number") return `${label} downloading`;
      if (typeof totalBytes !== "number" || totalBytes <= 0) {
        return `${label} downloading ${formatMib(receivedBytes)}`;
      }
      const percent = Math.floor((receivedBytes / totalBytes) * 100);
      return `${label} downloading ${percent}% (${formatMib(receivedBytes)}/${formatMib(totalBytes)})`;
    }
    case "verifying":
      return `${label} verifying`;
    case "extracting":
      return `${label} extracting`;
    case "installed":
      return `${label} installed`;
  }
}

function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function summarize(rows: ToolStatusRow[]): string {
  return rows
    .map((row) => (row.installed ? `${row.tool} ${row.version}` : `${row.tool} missing`))
    .join(", ");
}

function statusRow(tool: string, resolved: ToolResolution | null): ToolStatusRow {
  return {
    tool,
    installed: resolved != null,
    packageName: resolved?.packageName ?? null,
    version: resolved?.version ?? null,
    entryPath: resolved?.entryPath ?? null,
  };
}

/**
 * `ade tools` — inspect and populate the pinned agent-tools cache.
 *
 * The brain fetches these in the background on `ade serve`, so this command
 * exists for the cases where waiting for that is wrong: the installer wants the
 * download to finish before it hands the machine over, CI wants a warm cache,
 * and a user debugging a failed fetch wants the error rather than a silent
 * retry.
 */
export async function runToolsCommand(
  rest: string[],
  deps: ToolsCommandDeps = {},
): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ensure = deps.ensure ?? ensureTools;
  const collect = deps.gc ?? gcTools;
  const resolve = deps.resolve ?? tryResolveTool;
  const pinned = (deps.listPinned ?? listPinnedTools)({ env });

  const positionals = rest.filter((arg) => !arg.startsWith("-"));
  const sub = positionals[0] ?? "status";
  const textProgress = deps.textProgress === true;
  const toolsRoot = resolveMachineToolsRoot(env);

  if (sub === "status") {
    const tools = pinned.map((tool) => statusRow(tool, resolve(tool, { env })));
    return {
      ok: true,
      action: "tools-status",
      toolsRoot,
      // The generic --text renderer truncates nested objects, so the per-tool
      // detail below is unreadable there. This line carries the same facts in a
      // form a human (and the installer's output) can actually use.
      summary: summarize(tools),
      tools,
      missing: tools.filter((row) => !row.installed).map((row) => row.tool),
    };
  }

  if (sub === "ensure") {
    // Named tools are opt-in; with none the command means "everything this
    // build pins", which is what the installer and the brain both want.
    const requested = positionals.slice(1);
    for (const name of requested) {
      if (!pinned.includes(name)) {
        throw new ToolsUsageError(
          `Unknown ADE agent tool ${JSON.stringify(name)}. Pinned tools: ${pinned.join(", ")}.`,
        );
      }
    }
    const names = requested.length > 0 ? requested : pinned;
    const startedAtMs = Date.now();
    try {
      const resolved = await ensure(names, {
        env,
        onProgress: textProgress ? (progress) => write(describeProgress(progress)) : undefined,
      });
      return {
        ok: true,
        action: "tools-ensure",
        toolsRoot,
        durationMs: Date.now() - startedAtMs,
        summary: summarize(names.map((name) => statusRow(name, resolved.get(name) ?? null))),
        tools: names.map((name) => statusRow(name, resolved.get(name) ?? null)),
      };
    } catch (error) {
      // The typed kind is the whole point of the tools module: callers and
      // support threads branch on it rather than parsing the message.
      if (isToolError(error)) {
        return {
          ok: false,
          action: "tools-ensure",
          toolsRoot,
          durationMs: Date.now() - startedAtMs,
          errorKind: error.kind,
          tool: error.tool ?? null,
          packageName: error.packageName ?? null,
          version: error.version ?? null,
          message: error.message,
        };
      }
      throw error;
    }
  }

  if (sub === "gc") {
    const dryRun = rest.includes("--dry-run");
    const result = await collect({ env, dryRun, keepPrevious: !rest.includes("--no-keep-previous") });
    return {
      ok: true,
      action: "tools-gc",
      toolsRoot,
      dryRun,
      removed: result.removed,
      kept: result.kept,
    };
  }

  throw new ToolsUsageError("tools supports ensure, status, or gc.");
}
