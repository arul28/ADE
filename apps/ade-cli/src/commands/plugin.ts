// ---------------------------------------------------------------------------
// `ade plugin` — the operator-facing half of the ADE plugin platform.
//
//   ade plugin list [--text|--json]
//   ade plugin create <name> [--dir <path>]
//   ade plugin install <source> [--ref <ref>] [--no-enable]
//   ade plugin remove|uninstall <id>
//   ade plugin enable <id> | disable <id> | reload <id>
//   ade plugin logs <id> [--limit <n>]
//   ade plugin dev [<id>|<path>]
//
// Two halves, deliberately split:
//
//   * `list`, `create` are DAEMON-FREE. They read the machine install registry
//     (`<adeDir>/plugins/state.json`) and write scaffolding, so an operator can
//     see what is installed and start a plugin with the app closed — the same
//     posture as `ade skill`.
//   * everything that mutates installed state rides the ONE `plugin` action
//     domain (D1) through an injected `invokeAction`, so this module never owns
//     a transport and stays testable without a socket.
//
// The registry is the ONLY source of truth for "installed". A directory sitting
// under the plugins root that no `state.json` entry names is not a plugin — it
// is a leftover, a half-finished clone, or someone's scratch copy, and listing
// it would invite enabling code the operator never installed.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

import {
  isValidPluginId,
  parsePluginManifestJson,
  type PluginManifest,
} from "../../../desktop/src/shared/plugins/manifest";
import { readPluginInstallRecords } from "../../../desktop/src/main/services/plugins/pluginRegistryFile";
import type {
  PluginDetail,
  PluginInstallRecord,
  PluginInstallSource,
  PluginLogEntry,
  PluginSummary,
} from "../../../desktop/src/shared/plugins/sdk";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";

export class CliPluginUsageError extends Error {}

export type PluginCliResult = {
  output: string;
  exitCode: number;
};

/** How this command reaches the `plugin` action domain. Supplied by cli.ts. */
export type PluginActionInvoker = (
  action: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type PluginCommandDeps = {
  invokeAction?: PluginActionInvoker;
  /** Sink for `ade plugin dev`, which prints while it watches. */
  write?: (text: string) => void;
};

const HELP_PLUGIN = [
  "Usage:",
  "  ade plugin list [--text|--json]           List plugins installed on this machine",
  "  ade plugin create <name> [--dir <path>]   Scaffold a new plugin directory",
  "  ade plugin install <source> [--ref <r>]   Install from a git URL or local path",
  "  ade plugin remove <id>                    Uninstall a plugin",
  "  ade plugin enable <id> | disable <id>     Turn a plugin on or off",
  "  ade plugin reload <id>                    Re-read the manifest and restart it",
  "  ade plugin logs <id> [--limit <n>]        Show a plugin's recent log lines",
  "  ade plugin dev [<id>|<path>]              Watch a plugin directory and reload on change",
  "",
  "  list and create work without the ADE brain; everything else runs through",
  "  it. JSON output is the default; pass --text for human-readable output.",
  "",
  "Flags:",
  "  --no-enable   Install without enabling the plugin.",
  "  --limit <n>   Log lines to show (default 50).",
].join("\n");

// ---------------------------------------------------------------------------
// Install registry (daemon-free)
// ---------------------------------------------------------------------------

const PLUGIN_MANIFEST_FILE = "plugin.json";
const DEFAULT_LOG_LIMIT = 50;

export type InstalledPlugin = {
  pluginId: string;
  root: string;
  record: PluginInstallRecord;
  manifest: PluginManifest | null;
  errors: string[];
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolvePluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeLayout(env).adeDir, "plugins");
}

function readPluginManifestAt(root: string): {
  manifest: PluginManifest | null;
  errors: string[];
  warnings: string[];
} {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, PLUGIN_MANIFEST_FILE), "utf8");
  } catch {
    return { manifest: null, errors: [`${PLUGIN_MANIFEST_FILE} is missing or unreadable`], warnings: [] };
  }
  return parsePluginManifestJson(text);
}

/** Every plugin the registry names, in id order. Never a directory scan. */
export function readInstalledPlugins(env: NodeJS.ProcessEnv = process.env): InstalledPlugin[] {
  const pluginsRoot = resolvePluginsRoot(env);
  const entries: InstalledPlugin[] = [];
  for (const [pluginId, record] of readPluginInstallRecords(pluginsRoot)) {
    const root = path.join(pluginsRoot, pluginId);
    const parsed = readPluginManifestAt(root);
    entries.push({ pluginId, root, record, ...parsed });
  }
  return entries.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

export type PluginCliRoute = {
  pluginId: string;
  /** The declared word `ade <id> <word>` resolved to, or null for a bare id. */
  command: string | null;
};

/**
 * Decide whether `ade <primary> ...` belongs to an installed plugin (D18).
 *
 * Deliberately narrow: an id shape the manifest contract would refuse, a plugin
 * that is not installed, one that is disabled, or a word it never declared all
 * return null so the caller keeps its own "Unknown command" error. A typo must
 * read as a typo, not as a plugin failure.
 */
export function resolvePluginCliRoute(
  primary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): PluginCliRoute | null {
  if (!isValidPluginId(primary)) return null;
  const pluginsRoot = resolvePluginsRoot(env);
  const record = readPluginInstallRecords(pluginsRoot).get(primary);
  if (!record || !record.enabled) return null;
  const { manifest } = readPluginManifestAt(path.join(pluginsRoot, primary));
  if (!manifest || manifest.cli.length === 0) return null;
  const word = args.find((arg) => arg !== "--" && !arg.startsWith("-")) ?? null;
  // A bare `ade <id>` still routes: the plugin owns its own usage text, and
  // refusing it here would answer "Unknown command" for a command that exists.
  if (word !== null && !manifest.cli.includes(word)) return null;
  return { pluginId: primary, command: word };
}

/**
 * What `ade <pluginId>` prints when no word follows it.
 *
 * The plugin's manifest is the only description of what it accepts, and it is
 * already on disk — so this answers with the app closed, the same posture as
 * `ade skill`. Routing a bare id into the plugin instead would reach a child
 * process that was handed no action and could only fail.
 */
export function pluginCliUsageText(pluginId: string, env: NodeJS.ProcessEnv = process.env): string {
  const { manifest } = readPluginManifestAt(path.join(resolvePluginsRoot(env), pluginId));
  const title = manifest?.displayName?.trim() || pluginId;
  const description = manifest?.description?.trim();
  const words = manifest?.cli ?? [];
  return [
    description ? `${title} — ${description}` : title,
    "",
    "Usage:",
    ...(words.length
      ? words.map((word) => `  ade ${pluginId} ${word}`)
      : [`  ${pluginId} declares no commands.`]),
    "",
    `Logs: ade plugin logs ${pluginId}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

type OutputFormat = "json" | "text";

function extractFormat(args: string[]): { format: OutputFormat; rest: string[] } {
  let format: OutputFormat = "json";
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--text") {
      format = "text";
      continue;
    }
    if (arg === "--json") {
      format = "json";
      continue;
    }
    rest.push(arg);
  }
  return { format, rest };
}

function readOption(args: string[], name: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === name) {
      const next = args[index + 1];
      if (next == null) throw new CliPluginUsageError(`${name} requires a value.`);
      value = next;
      index += 1;
      continue;
    }
    if (token.startsWith(`${name}=`)) {
      value = token.slice(name.length + 1);
      continue;
    }
    rest.push(token);
  }
  return { value, rest };
}

function readFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest = args.filter((arg) => arg !== name);
  return { present: rest.length !== args.length, rest };
}

function requirePluginId(value: string | undefined, usage: string): string {
  if (!value) throw new CliPluginUsageError(usage);
  if (!isValidPluginId(value)) {
    throw new CliPluginUsageError(
      `Invalid plugin id "${value}". Ids are lowercase kebab-case and start with a letter.`,
    );
  }
  return value;
}

function jsonOutput(value: unknown): PluginCliResult {
  return { output: `${JSON.stringify(value, null, 2)}\n`, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// list (daemon-free)
// ---------------------------------------------------------------------------

export type PluginListEntry = {
  pluginId: string;
  version: string;
  displayName: string;
  description: string;
  enabled: boolean;
  hasEntry: boolean;
  source: PluginInstallSource;
  installedAt: string;
  root: string;
  cli: string[];
  surfaces: { kind: string; id: string; title: string; panelId: string }[];
  /** Socket contributions the user switched off, as the registry stores them. */
  disabledContributions: string[];
  errors: string[];
  warnings: string[];
};

function toListEntry(entry: InstalledPlugin): PluginListEntry {
  const { manifest } = entry;
  return {
    pluginId: entry.pluginId,
    version: manifest?.version ?? entry.record.version,
    displayName: manifest?.displayName ?? entry.pluginId,
    description: manifest?.description ?? "",
    enabled: entry.record.enabled,
    hasEntry: Boolean(manifest?.entry),
    source: entry.record.source,
    installedAt: entry.record.installedAt,
    root: entry.root,
    cli: manifest?.cli ?? [],
    surfaces: manifest?.surfaces.map((surface) => ({
      kind: surface.kind,
      id: surface.id,
      title: surface.title,
      panelId: surface.panelId,
    })) ?? [],
    disabledContributions: entry.record.disabledContributions ?? [],
    errors: entry.errors,
    warnings: entry.warnings,
  };
}

export function runPluginList(args: string[]): PluginCliResult {
  const { format } = extractFormat(args);
  const entries = readInstalledPlugins().map(toListEntry);
  if (format === "text") {
    if (entries.length === 0) {
      return { output: "No plugins installed on this machine.\n", exitCode: 0 };
    }
    const lines = entries.map((entry) => {
      const state = entry.enabled ? "enabled" : "disabled";
      const head = `${entry.pluginId} ${entry.version} — ${entry.displayName} (${state})`;
      return entry.errors.length ? `${head}\n  ${entry.errors.join("\n  ")}` : head;
    });
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }
  return jsonOutput(entries);
}

// ---------------------------------------------------------------------------
// create (daemon-free)
// ---------------------------------------------------------------------------

function displayNameFromId(pluginId: string): string {
  return pluginId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function scaffoldManifest(pluginId: string, displayName: string): string {
  return `${JSON.stringify(
    {
      name: pluginId,
      version: "0.1.0",
      displayName,
      description: `${displayName} — an ADE plugin.`,
      vocabVersion: 1,
      entry: "index.js",
      surfaces: [{ kind: "tab", id: pluginId, title: displayName, panelId: "main" }],
      panels: [{ id: "main", schemaFile: "panels/main.json", title: displayName }],
      cli: ["status"],
      official: false,
    },
    null,
    2,
  )}\n`;
}

function scaffoldEntry(pluginId: string, displayName: string): string {
  return [
    `// ${displayName} — ADE plugin entry point.`,
    "//",
    "// `ade` is the SDK handed to activate() and available as a global inside the",
    "// plugin child process. Everything it exposes is async and host-mediated:",
    "// there is no direct database, filesystem, or network authority here.",
    "",
    "exports.activate = async (ade) => {",
    `  ade.log("info", "${pluginId} activated");`,
    "};",
    "",
    "exports.actions = {",
    "  status: async () => ({",
    `    plugin: "${pluginId}",`,
    "    ok: true,",
    "  }),",
    "};",
    "",
  ].join("\n");
}

function scaffoldPanel(displayName: string): string {
  // Shape checked by shared/plugins/vocabulary.ts: `v`, a required `fallback`
  // for clients that cannot render the body, and the body itself.
  return `${JSON.stringify(
    {
      v: 1,
      title: displayName,
      fallback: { title: displayName, text: "Open ADE to see this panel." },
      body: [
        {
          component: "stack",
          gap: "md",
          children: [
            { component: "text", text: "Hello", variant: "title" },
            { component: "text", text: "Edit panels/main.json to change this panel." },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function scaffoldReadme(pluginId: string, displayName: string): string {
  return [
    `# ${displayName}`,
    "",
    "An ADE plugin.",
    "",
    "## Layout",
    "",
    "- `plugin.json` — manifest: identity, surfaces, panels, CLI words.",
    "- `index.js` — plugin code, run on the owning machine in a supervised child process.",
    "- `panels/main.json` — the panel's declarative vocabulary schema.",
    "",
    "## Develop",
    "",
    "```sh",
    "ade plugin install .",
    `ade plugin dev ${pluginId}`,
    "```",
    "",
    `\`ade plugin dev\` watches this directory and reloads the plugin on every save.`,
    "",
  ].join("\n");
}

export function runPluginCreate(args: string[]): PluginCliResult {
  const { format, rest: formatRest } = extractFormat(args);
  const { value: dirOption, rest } = readOption(formatRest, "--dir");
  const pluginId = requirePluginId(rest[0], "ade plugin create <name> [--dir <path>]");
  const parent = path.resolve(dirOption ?? process.cwd());
  const root = path.join(parent, pluginId);
  if (fs.existsSync(root)) {
    throw new CliPluginUsageError(`${root} already exists. Choose another name or --dir.`);
  }

  const displayName = displayNameFromId(pluginId);
  const files: Record<string, string> = {
    [PLUGIN_MANIFEST_FILE]: scaffoldManifest(pluginId, displayName),
    "index.js": scaffoldEntry(pluginId, displayName),
    [path.join("panels", "main.json")]: scaffoldPanel(displayName),
    "README.md": scaffoldReadme(pluginId, displayName),
  };
  fs.mkdirSync(path.join(root, "panels"), { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, relative), contents, "utf8");
  }

  const written = Object.keys(files).sort();
  if (format === "text") {
    return {
      output: [
        `Created ${displayName} at ${root}`,
        ...written.map((relative) => `  ${relative}`),
        "",
        `Next: ade plugin install ${root} && ade plugin dev ${pluginId}`,
        "",
      ].join("\n"),
      exitCode: 0,
    };
  }
  return jsonOutput({ pluginId, displayName, root, files: written });
}

// ---------------------------------------------------------------------------
// Daemon-backed subcommands
// ---------------------------------------------------------------------------

function requireInvoker(deps: PluginCommandDeps | undefined, subcommand: string): PluginActionInvoker {
  const invoke = deps?.invokeAction;
  if (!invoke) {
    throw new CliPluginUsageError(
      `ade plugin ${subcommand} needs the ADE brain. Run it through the ade CLI, or start the brain with 'ade brain start'.`,
    );
  }
  return invoke;
}

function summaryLine(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value ?? null);
  const summary = value as Partial<PluginSummary>;
  if (typeof summary.pluginId !== "string") return JSON.stringify(value);
  const state = summary.enabled === false ? "disabled" : "enabled";
  const status = typeof summary.status === "string" ? `, ${summary.status}` : "";
  const head = [summary.pluginId, summary.version].filter(Boolean).join(" ");
  return `${head} — ${summary.displayName ?? summary.pluginId} (${state}${status})`;
}

function daemonResult(value: unknown, format: OutputFormat): PluginCliResult {
  if (format === "text") return { output: `${summaryLine(value)}\n`, exitCode: 0 };
  return jsonOutput(value ?? null);
}

async function runPluginInstall(
  args: string[],
  format: OutputFormat,
  deps: PluginCommandDeps | undefined,
): Promise<PluginCliResult> {
  const { value: ref, rest: afterRef } = readOption(args, "--ref");
  const { present: noEnable, rest } = readFlag(afterRef, "--no-enable");
  const source = rest[0];
  if (!source) {
    throw new CliPluginUsageError("ade plugin install <source> [--ref <ref>] [--no-enable]");
  }
  const invoke = requireInvoker(deps, "install");
  const result = await invoke("install", {
    source,
    ...(ref ? { ref } : {}),
    enable: !noEnable,
  });
  return daemonResult(result, format);
}

async function runPluginLifecycle(
  action: "uninstall" | "enable" | "disable" | "reload",
  args: string[],
  format: OutputFormat,
  deps: PluginCommandDeps | undefined,
): Promise<PluginCliResult> {
  const usage = action === "uninstall"
    ? "ade plugin remove <id>"
    : `ade plugin ${action} <id>`;
  const pluginId = requirePluginId(args[0], usage);
  const invoke = requireInvoker(deps, action);
  const result = await invoke(action, { pluginId });
  if (action === "uninstall" && format === "text") {
    const removed = isRecord(result) && result.removed === true;
    return {
      output: removed ? `Removed ${pluginId}.\n` : `${pluginId} was not installed.\n`,
      exitCode: 0,
    };
  }
  return daemonResult(result, format);
}

async function runPluginLogs(
  args: string[],
  format: OutputFormat,
  deps: PluginCommandDeps | undefined,
): Promise<PluginCliResult> {
  const { value: limitOption, rest } = readOption(args, "--limit");
  const pluginId = requirePluginId(rest[0], "ade plugin logs <id> [--limit <n>]");
  const limit = limitOption == null ? DEFAULT_LOG_LIMIT : Number(limitOption);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliPluginUsageError("--limit must be a positive integer.");
  }
  const invoke = requireInvoker(deps, "logs");
  const detail = await invoke("get", { pluginId });
  if (!isRecord(detail)) {
    throw new CliPluginUsageError(`Plugin ${pluginId} is not installed on this machine.`);
  }
  const logs = Array.isArray((detail as Partial<PluginDetail>).logs)
    ? ((detail as PluginDetail).logs as PluginLogEntry[])
    : [];
  const recent = logs.slice(-limit);
  if (format === "text") {
    if (recent.length === 0) return { output: `No log lines for ${pluginId}.\n`, exitCode: 0 };
    const lines = recent.map((entry) => `${entry.at} ${entry.level.padEnd(5)} ${entry.message}`);
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }
  return jsonOutput(recent);
}

// ---------------------------------------------------------------------------
// dev — watch a plugin directory, reload on change
// ---------------------------------------------------------------------------

const DEV_DEBOUNCE_MS = 300;

function resolveDevTarget(target: string | undefined): { pluginId: string; root: string } {
  const fromDirectory = (directory: string): { pluginId: string; root: string } => {
    const root = path.resolve(directory);
    const { manifest } = readPluginManifestAt(root);
    if (!manifest) {
      throw new CliPluginUsageError(`No readable ${PLUGIN_MANIFEST_FILE} in ${root}.`);
    }
    return { pluginId: manifest.name, root };
  };
  if (!target) return fromDirectory(process.cwd());
  // An installed id wins over a same-named directory only when the id is not
  // also a real plugin directory here — running `ade plugin dev` inside a
  // checkout must watch the checkout, not the installed copy.
  if (fs.existsSync(path.join(path.resolve(target), PLUGIN_MANIFEST_FILE))) {
    return fromDirectory(target);
  }
  if (!isValidPluginId(target)) {
    throw new CliPluginUsageError(`${target} is neither a plugin directory nor a plugin id.`);
  }
  const pluginsRoot = resolvePluginsRoot();
  if (!readPluginInstallRecords(pluginsRoot).has(target)) {
    throw new CliPluginUsageError(`Plugin ${target} is not installed on this machine.`);
  }
  return fromDirectory(path.join(pluginsRoot, target));
}

async function runPluginDev(
  args: string[],
  format: OutputFormat,
  deps: PluginCommandDeps | undefined,
): Promise<PluginCliResult> {
  const target = resolveDevTarget(args[0]);
  const invoke = requireInvoker(deps, "dev");
  const write = deps?.write ?? ((text: string) => void process.stdout.write(text));
  const emit = (event: string, fields: Record<string, unknown>, text: string): void => {
    write(format === "text" ? `${text}\n` : `${JSON.stringify({ event, ...fields })}\n`);
  };

  emit(
    "watching",
    { pluginId: target.pluginId, root: target.root },
    `Watching ${target.root} — saving a file reloads ${target.pluginId}.`,
  );

  let unreachable = false;
  let timer: NodeJS.Timeout | null = null;
  let reloading = false;
  let pending = false;

  const reload = async (): Promise<void> => {
    if (reloading) {
      pending = true;
      return;
    }
    reloading = true;
    try {
      await invoke("reload", { pluginId: target.pluginId });
      if (unreachable) {
        unreachable = false;
        emit("reconnected", { pluginId: target.pluginId }, "ADE is back — reloading again.");
      }
      emit("reloaded", { pluginId: target.pluginId }, `Reloaded ${target.pluginId}.`);
    } catch (error) {
      // A dev loop must outlive a closed app: say it once, keep watching, and
      // pick the plugin back up when the brain returns.
      if (!unreachable) {
        unreachable = true;
        emit(
          "unreachable",
          { pluginId: target.pluginId, error: error instanceof Error ? error.message : String(error) },
          "ADE is not reachable — still watching; changes will apply once it is back.",
        );
      }
    } finally {
      reloading = false;
      if (pending) {
        pending = false;
        void reload();
      }
    }
  };

  const watchers: fs.FSWatcher[] = [];
  const onChange = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void reload();
    }, DEV_DEBOUNCE_MS);
  };
  const watch = (directory: string, recursive: boolean): boolean => {
    try {
      watchers.push(fs.watch(directory, { recursive }, onChange));
      return true;
    } catch {
      return false;
    }
  };
  if (!watch(target.root, true)) {
    // Platforms without recursive fs.watch still need the two directories that
    // actually change during development.
    watch(target.root, false);
    const panelsDir = path.join(target.root, "panels");
    if (fs.existsSync(panelsDir)) watch(panelsDir, false);
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return { output: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/**
 * Every `ade plugin` word, in one table.
 *
 * `kind` is the whole routing decision: `local` runs against the install
 * registry with the app closed, `daemon` rides the `plugin` action domain. A
 * word absent from this table is a typo and says so — the previous shape had a
 * Set plus two switches whose `default` arm ran `dev`, so a misspelled
 * daemon-backed subcommand silently started a file watcher.
 */
type PluginSubcommand =
  | { kind: "local"; run: (args: string[]) => PluginCliResult }
  | {
    kind: "daemon";
    run: (args: string[], format: OutputFormat, deps: PluginCommandDeps | undefined) => Promise<PluginCliResult>;
  };

const PLUGIN_SUBCOMMANDS: Record<string, PluginSubcommand> = {
  list: { kind: "local", run: (args) => runPluginList(args) },
  create: { kind: "local", run: (args) => runPluginCreate(args) },
  install: { kind: "daemon", run: (args, format, deps) => runPluginInstall(args, format, deps) },
  remove: { kind: "daemon", run: (args, format, deps) => runPluginLifecycle("uninstall", args, format, deps) },
  uninstall: { kind: "daemon", run: (args, format, deps) => runPluginLifecycle("uninstall", args, format, deps) },
  enable: { kind: "daemon", run: (args, format, deps) => runPluginLifecycle("enable", args, format, deps) },
  disable: { kind: "daemon", run: (args, format, deps) => runPluginLifecycle("disable", args, format, deps) },
  reload: { kind: "daemon", run: (args, format, deps) => runPluginLifecycle("reload", args, format, deps) },
  logs: { kind: "daemon", run: (args, format, deps) => runPluginLogs(args, format, deps) },
  dev: { kind: "daemon", run: (args, format, deps) => runPluginDev(args, format, deps) },
};

function findSubcommand(verb: string): PluginSubcommand | null {
  return Object.hasOwn(PLUGIN_SUBCOMMANDS, verb) ? PLUGIN_SUBCOMMANDS[verb] ?? null : null;
}

/** The daemon-free subset. Throws for anything that needs the action domain. */
export function runPluginCommand(argv: string[]): PluginCliResult {
  const verb = argv[0];
  if (!verb || verb === "--help" || verb === "-h") {
    return { output: `${HELP_PLUGIN}\n`, exitCode: 0 };
  }
  const subcommand = findSubcommand(verb);
  if (!subcommand) {
    throw new CliPluginUsageError(
      `Unknown plugin subcommand: ${verb}. Run 'ade plugin --help' for the list.`,
    );
  }
  if (subcommand.kind === "daemon") {
    throw new CliPluginUsageError(
      `ade plugin ${verb} needs the ADE brain. Run it through the ade CLI, or start the brain with 'ade brain start'.`,
    );
  }
  return subcommand.run(argv.slice(1));
}

export async function runPluginCommandAsync(
  argv: string[],
  deps?: PluginCommandDeps,
): Promise<PluginCliResult> {
  const verb = argv[0];
  const subcommand = verb ? findSubcommand(verb) : null;
  if (!subcommand || subcommand.kind === "local") return runPluginCommand(argv);
  const { format, rest } = extractFormat(argv.slice(1));
  return await subcommand.run(rest, format, deps);
}
