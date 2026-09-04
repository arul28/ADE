// ---------------------------------------------------------------------------
// `ade plugin` — the operator-facing half of the ADE plugin platform.
//
//   ade plugin list [--text|--json]
//   ade plugin create <name> [--dir <path>] [--webview]
//   ade plugin install <source> [--ref <ref>] [--no-enable]
//   ade plugin remove|uninstall <id>
//   ade plugin enable <id> | disable <id> | reload <id>
//   ade plugin logs <id> [--limit <n>]
//   ade plugin doctor <id>
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
import { isRecord } from "../../../desktop/src/shared/plugins/parse";
import { readPluginInstallRecords } from "../../../desktop/src/main/services/plugins/pluginRegistryFile";
import type {
  PluginContributionRecord,
  PluginDetail,
  PluginInstallRecord,
  PluginInstallSource,
  PluginLogEntry,
  PluginPresenceMachineRow,
  PluginSummary,
  PluginUsageSummary,
  PluginWebhookIngressStatus,
} from "../../../desktop/src/shared/plugins/sdk";
import { PLUGIN_SKILL_NEXT_TURN_NOTE } from "../../../desktop/src/shared/plugins/clientRendering";
import {
  buildPluginDoctorReport,
  formatPluginDoctorReport,
  pluginDoctorExitCode,
  type PluginDoctorLive,
} from "./pluginDoctor";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { firstStandalonePositionalWord } from "../cliArgScan";

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
  "  ade plugin create <name> [--dir <path>] [--webview]",
  "                                            Scaffold a new plugin directory",
  "  ade plugin install <source> [--ref <r>]   Install from a git URL or local path",
  "  ade plugin remove <id>                    Uninstall a plugin",
  "  ade plugin enable <id> | disable <id>     Turn a plugin on or off",
  "  ade plugin reload <id>                    Re-copy a local source, then restart it",
  "  ade plugin logs <id> [--limit <n>]        Show a plugin's recent log lines",
  "  ade plugin doctor <id>                    Check every layer between installed and visible",
  "  ade plugin dev [<id>|<path>]              Watch a plugin directory and reload on change",
  "",
  "  list and create work without the ADE brain; everything else runs through",
  "  it. JSON output is the default; pass --text for human-readable output.",
  "",
  "Flags:",
  "  --webview     Scaffold a plugin whose surface is its own HTML page.",
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
  // Not the first token without a dash: in `--repo runs launch` that token is
  // the VALUE of `--repo`, and routing on it sends the command somewhere the
  // reader never asked for. See `cliArgScan.ts`.
  const word = firstStandalonePositionalWord(args);
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
  surfaces: { kind: string; id: string; title: string; panelId: string; entryHtml?: string }[];
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
      // Read off the manifest on disk, so this is the "declared" half an author
      // compares against what the running app serves. `ade plugin doctor` makes
      // the same comparison and says which half is wrong.
      ...(surface.entryHtml ? { entryHtml: surface.entryHtml } : {}),
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

function scaffoldManifest(pluginId: string, displayName: string, webview: boolean): string {
  return `${JSON.stringify(
    {
      name: pluginId,
      version: "0.1.0",
      displayName,
      description: `${displayName} — an ADE plugin.`,
      vocabVersion: 1,
      entry: "index.js",
      // A `webview` surface still names a `panelId`. The page is what desktop
      // and hosted web draw; the panel is what the terminal and the phone draw,
      // and a surface without one would simply be missing on two clients.
      surfaces: [
        webview
          ? {
            kind: "webview",
            id: pluginId,
            title: displayName,
            panelId: "main",
            entryHtml: "page/index.html",
          }
          : { kind: "tab", id: pluginId, title: displayName, panelId: "main" },
      ],
      panels: [{ id: "main", schemaFile: "panels/main.json", title: displayName }],
      // A socket, so the scaffold has one action a person can actually PRESS
      // and one handler that reads a real context object. Both shapes — the
      // context on a socket press and `argv` on a CLI word — have now cost an
      // author a debugging session apiece for being guessed at rather than
      // copied, so the starter demonstrates each of them working.
      sockets: [
        {
          socket: "toolbar-action",
          surface: "app",
          id: "hello",
          label: displayName,
          actionId: "hello",
        },
      ],
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
    "// Every action takes ONE object. What is in it depends on how the action was",
    "// reached, and neither shape is nested under a further key:",
    "//",
    "//   a socket press  ->  { context: { kind: \"surface\", surface: \"app\" } }",
    "//   an `ade` word   ->  { argv: [\"status\", \"--json\"] }",
    "//",
    "// The context object IS the subject — a session context is",
    "// { kind: \"session\", id, title, ... }, so it is `args.context.id` and never",
    "// `args.context.session.id`. argv is a property of the same object, so it is",
    "// `args.argv`, never the parameter itself.",
    "exports.actions = {",
    "  // Reached from the toolbar button this plugin declares in plugin.json.",
    "  hello: async (args) => {",
    "    const context = args.context;",
    `    ade.log("info", "${pluginId} pressed", { surface: context.surface });`,
    "    // Send the user to this plugin's own tab. Return nothing to stay put.",
    '    return { navigate: { panelId: "main" } };',
    "  },",
    "",
    `  // Reached as \`ade ${pluginId} status [...]\`. Every word after the plugin`,
    "  // id arrives in args.argv, and that INCLUDES \"status\" itself — so drop the",
    "  // first non-flag word to get your own arguments. Parsing the flags is",
    "  // yours: ADE hands over the words untouched.",
    "  status: async (args) => {",
    "    const argv = args.argv || [];",
    '    const words = argv.filter((word) => !word.startsWith("-"));',
    "    const rest = words.slice(1);",
    "    return {",
    `      plugin: "${pluginId}",`,
    "      ok: true,",
    "      arguments: rest,",
    "    };",
    "  },",
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

/**
 * The page a `--webview` scaffold ships.
 *
 * Framework-free on purpose, and it is not laziness: the CSP the host serves is
 * `script-src 'self'`, so there is no inline `<script>` and no CDN. Everything
 * the page runs is a relative file inside the plugin's own directory, which is
 * exactly the shape a real build (Vite into `dist/`) has to produce as well —
 * an author who starts here does not discover the rule after writing a page
 * that cannot load.
 */
function scaffoldPageHtml(displayName: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${displayName}</title>`,
    // A relative href, like every asset here: the page's origin is
    // `ade-plugin://<id>`, and nothing outside it loads.
    '    <link rel="stylesheet" href="./page.css" />',
    "  </head>",
    "  <body>",
    '    <main id="app">',
    `      <h1>${displayName}</h1>`,
    '      <p id="status">Talking to ADE…</p>',
    '      <button id="save" type="button">Save a note</button>',
    "    </main>",
    // Deferred and external. An inline script is refused by the CSP the host
    // serves with this file, so this is the only shape that runs.
    '    <script src="./page.js" defer></script>',
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

function scaffoldPageCss(): string {
  return [
    "/* The host publishes its palette as --ade-* custom properties through",
    "   adePlugin.theme.get(). Read them rather than hard-coding a colour, so the",
    "   page follows the reader's theme instead of fighting it. */",
    "body {",
    "  margin: 0;",
    "  font: 13px/1.5 system-ui, -apple-system, sans-serif;",
    "  color: var(--ade-text, #e8e6ef);",
    "  background: var(--ade-bg, #0f0d14);",
    "}",
    "",
    "#app {",
    "  padding: 16px;",
    "}",
    "",
    "button {",
    "  font: inherit;",
    "  padding: 6px 12px;",
    "  border-radius: 6px;",
    "  border: 1px solid var(--ade-border, #35323f);",
    "  background: var(--ade-surface, #1a1822);",
    "  color: inherit;",
    "  cursor: pointer;",
    "}",
    "",
  ].join("\n");
}

function scaffoldPageJs(pluginId: string): string {
  return [
    "// The page half of this plugin. Everything ADE offers a page is on",
    "// `window.adePlugin` — a closed list, scoped to this plugin, with no plugin",
    "// id on the wire: the host answers every call against this page's own origin.",
    "//",
    "// Check `adePlugin.version` before calling something an older ADE lacks.",
    "",
    "const bridge = window.adePlugin;",
    'const status = document.getElementById("status");',
    'const save = document.getElementById("save");',
    "",
    "function paintTheme(theme) {",
    "  // The host hands over the same --ade-* tokens ADE paints itself with.",
    "  for (const [name, value] of Object.entries(theme.tokens || {})) {",
    "    document.documentElement.style.setProperty(name, value);",
    "  }",
    "}",
    "",
    "async function main() {",
    "  if (!bridge) {",
    '    status.textContent = "This page is not running inside ADE.";',
    "    return;",
    "  }",
    "",
    "  paintTheme(await bridge.theme.get());",
    '  bridge.events.on("theme", paintTheme);',
    "",
    "  // `context.subject` is what the host attached this page to (a chat, a lane,",
    "  // a PR) and is null on a full tab. `context.project` is the project the",
    "  // window is bound to. Neither can be forged by the page.",
    "  const subject = bridge.context && bridge.context.subject;",
    "  const project = bridge.context && bridge.context.project;",
    "  status.textContent = subject",
    '    ? "Attached to a " + subject.kind + "."',
    '    : "Project: " + ((project && project.root) || "none") + ".";',
    "",
    "  // Collections are this plugin's own storage. Declare one in plugin.json",
    "  // before you write to it — an undeclared collection is refused, not created.",
    '  bridge.events.on("changed", (change) => {',
    '    if (change.collection === "notes") void render();',
    "  });",
    "",
    "  save.addEventListener(\"click\", async () => {",
    "    const answer = await bridge.ui.prompt({",
    `      id: "note",`,
    `      title: "What are you working on?",`,
    "    });",
    "    if (!answer) return;",
    `    await bridge.collections.put("notes", String(Date.now()), { text: answer.text });`,
    `    await bridge.ui.toast({ level: "success", message: "Saved." });`,
    "  });",
    "",
    "  await render();",
    "}",
    "",
    "async function render() {",
    "  // `list` returns at most 500 rows. A full page means there may be more:",
    "  // ask again with `after` set to the last key you got.",
    `  const rows = await bridge.collections.list("notes", { limit: 50 });`,
    `  const existing = document.getElementById("notes");`,
    "  if (existing) existing.remove();",
    '  const list = document.createElement("ul");',
    '  list.id = "notes";',
    "  for (const row of rows) {",
    '    const item = document.createElement("li");',
    '    item.textContent = String((row.value && row.value.text) || "");',
    "    list.append(item);",
    "  }",
    `  document.getElementById("app").append(list);`,
    "}",
    "",
    `void main().catch((error) => {`,
    `  status.textContent = "${pluginId} failed: " + error.message;`,
    "});",
    "",
  ].join("\n");
}

function scaffoldReadme(pluginId: string, displayName: string, webview: boolean): string {
  return [
    `# ${displayName}`,
    "",
    "An ADE plugin.",
    "",
    "## Layout",
    "",
    "- `plugin.json` — manifest: identity, surfaces, panels, sockets, CLI words.",
    "- `index.js` — plugin code, run on the owning machine in a supervised child process.",
    "- `panels/main.json` — the panel's declarative vocabulary schema.",
    ...(webview
      ? [
        "- `page/index.html`, `page/page.js`, `page/page.css` — the plugin's own page.",
        "",
        "## The page",
        "",
        "This plugin's surface is a `webview`: ADE draws `page/index.html` in a",
        "sandboxed guest with its own origin, `ade-plugin://" + pluginId + "`. The page",
        "talks to ADE through `window.adePlugin` and reaches nothing else — no Node,",
        "no `window.ade`, no raw IPC. The Content-Security-Policy the host serves is",
        "`script-src 'self'`, so every script is a separate file inside this",
        "directory and loads by a relative path; an inline `<script>` will not run,",
        "and neither will a CDN. Build with anything you like as long as it emits",
        "plain files here and you commit them. The panel in `panels/main.json` is",
        "what the terminal and the phone draw, so keep it working.",
      ]
      : []),
    "",
    "## Develop",
    "",
    "```sh",
    "ade plugin install .",
    `ade plugin dev .`,
    "```",
    "",
    "`ade plugin dev` watches this directory and reloads the plugin on every save.",
    "A reload re-copies this folder into the install directory first, so what you",
    "just edited is what runs.",
    "",
    "## Check an action without clicking anything",
    "",
    "```sh",
    `ade actions run plugin.invoke --input-json '{"pluginId":"${pluginId}","action":"hello","args":{"context":{"kind":"surface","surface":"app"}}}'`,
    `ade ${pluginId} status`,
    `ade plugin doctor ${pluginId} --text`,
    "```",
    "",
    "The first line presses the button without a button: it is the fastest way to",
    "find out whether a handler runs at all. `doctor`'s \"Last run\" line then says",
    "when each declared action last ran and how it ended.",
    "",
  ].join("\n");
}

export function runPluginCreate(args: string[]): PluginCliResult {
  const { format, rest: formatRest } = extractFormat(args);
  const { value: dirOption, rest: afterDir } = readOption(formatRest, "--dir");
  const { present: webview, rest } = readFlag(afterDir, "--webview");
  const pluginId = requirePluginId(rest[0], "ade plugin create <name> [--dir <path>] [--webview]");
  const parent = path.resolve(dirOption ?? process.cwd());
  const root = path.join(parent, pluginId);
  if (fs.existsSync(root)) {
    throw new CliPluginUsageError(`${root} already exists. Choose another name or --dir.`);
  }

  const displayName = displayNameFromId(pluginId);
  const files: Record<string, string> = {
    [PLUGIN_MANIFEST_FILE]: scaffoldManifest(pluginId, displayName, webview),
    "index.js": scaffoldEntry(pluginId, displayName),
    [path.join("panels", "main.json")]: scaffoldPanel(displayName),
    "README.md": scaffoldReadme(pluginId, displayName, webview),
    ...(webview
      ? {
        [path.join("page", "index.html")]: scaffoldPageHtml(displayName),
        [path.join("page", "page.js")]: scaffoldPageJs(pluginId),
        [path.join("page", "page.css")]: scaffoldPageCss(),
      }
      : {}),
  };
  fs.mkdirSync(path.join(root, "panels"), { recursive: true });
  if (webview) fs.mkdirSync(path.join(root, "page"), { recursive: true });
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
        `Next: ade plugin install ${root} && ade plugin dev ${root}`,
        "",
      ].join("\n"),
      exitCode: 0,
    };
  }
  return jsonOutput({ pluginId, displayName, root, webview, files: written });
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

/**
 * One line saying how a lifecycle call was authorized, or `null` when the host
 * did not report it.
 *
 * The reader of `ade plugin install` cannot see the chat the card was raised
 * in, and an agent reading this output used to have nothing at all to go on —
 * it inferred consent from how long the command took. `--json` carries the
 * whole `approval` object; this is the same fact for a person.
 */
function approvalLine(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.approval)) return null;
  const { required, decidedBy } = value.approval;
  if (decidedBy === "operator") return "Approved as this computer's operator; no card was needed.";
  if (decidedBy !== "card") return null;
  return required === true
    ? "Approved on a card in the chat."
    : "Approved earlier in this ADE run; the card was not shown again.";
}

/** Append {@link approvalLine} to a text result, leaving JSON untouched. */
function withApprovalLine(result: PluginCliResult, value: unknown, format: OutputFormat): PluginCliResult {
  if (format !== "text") return result;
  const line = approvalLine(value);
  return line ? { ...result, output: `${result.output}${line}\n` } : result;
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
  const installed = withApprovalLine(daemonResult(result, format), result, format);
  if (format !== "text") return installed;
  // A skill arriving is the one thing an install changes that the reader
  // cannot see, and the moment they will test it is the turn already running.
  // Read from the registry rather than the action result: the manifest is on
  // disk by now, and the summary carries no skill list.
  const pluginId = isRecord(result) && typeof result.pluginId === "string" ? result.pluginId : null;
  const { manifest } = pluginId
    ? readPluginManifestAt(path.join(resolvePluginsRoot(), pluginId))
    : { manifest: null };
  if (!manifest || manifest.skills.length === 0) return installed;
  return { ...installed, output: `${installed.output}${PLUGIN_SKILL_NEXT_TURN_NOTE}\n` };
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
    return withApprovalLine({
      output: removed ? `Removed ${pluginId}.\n` : `${pluginId} was not installed.\n`,
      exitCode: 0,
    }, result, format);
  }
  const summary = withApprovalLine(daemonResult(result, format), result, format);
  if (action !== "reload" || format !== "text") return summary;
  // A reload re-copies a local source before it restarts the child, and the one
  // thing the reader must never miss is a resync that was REFUSED — the whole
  // point of the re-copy is that "reloaded" cannot quietly mean "ran the old
  // bytes again". The warnings carry that sentence; printing only the summary
  // line would put it back where it was.
  const warnings = isRecord(result) && Array.isArray(result.warnings)
    ? result.warnings.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (warnings.length === 0) return summary;
  return { ...summary, output: `${summary.output}${warnings.map((line) => `${line}\n`).join("")}` };
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
// doctor — the state ladder
// ---------------------------------------------------------------------------

/**
 * Ask the host one question, and treat every failure as "nobody could say".
 *
 * Deliberately swallowing: `doctor` is the command someone runs when things are
 * already wrong, so a host that answers four of five questions must still print
 * four answers. The layer builder renders the fifth as unchecked rather than as
 * absent.
 */
async function askHost<T>(work: () => Promise<unknown>, fallback: T): Promise<T> {
  try {
    return ((await work()) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The live half of the ladder.
 *
 * `plugin.get` is the probe: if THAT cannot be reached the brain is not
 * answering at all, and the whole live half returns null so the report says so
 * once instead of printing "unknown" five times over.
 */
async function readPluginDoctorLive(
  pluginId: string,
  manifest: PluginManifest | null,
  invoke: PluginActionInvoker | undefined,
): Promise<PluginDoctorLive | null> {
  if (!invoke) return null;
  let detail: PluginDetail | null;
  try {
    detail = (await invoke("get", { pluginId })) as PluginDetail | null;
  } catch {
    return null;
  }

  const presenceRows = await askHost<PluginPresenceMachineRow[]>(() => invoke("presence", {}), []);
  const usageSummary = await askHost<PluginUsageSummary | null>(
    () => invoke("usageSummary", { pluginId }),
    null,
  );

  // One read per surface the manifest names, because `listContributions` is
  // scoped to a surface — asking for all eight would cost seven pointless round
  // trips on the usual plugin, which declares sockets on one.
  const surfaces = [...new Set((manifest?.sockets ?? []).map((socket) => socket.surface))];
  const contributions: PluginContributionRecord[] = [];
  for (const surface of surfaces) {
    const rows = await askHost<PluginContributionRecord[]>(
      () => invoke("listContributions", { surface }),
      [],
    );
    for (const row of rows) {
      if (row?.pluginId === pluginId) contributions.push(row);
    }
  }

  // Asked only when the manifest declares a channel: on a plugin that receives
  // nothing this is a round trip whose answer the rung would discard, and the
  // sentinel below has to keep meaning "the host has no such action" rather
  // than "we did not bother".
  const ingress = (manifest?.webhookIngress.length ?? 0) > 0
    ? await askHost<PluginWebhookIngressStatus[] | null>(
      () => invoke("webhookIngress", { pluginId }),
      null,
    )
    : [];

  return {
    detail: detail ?? null,
    presence: presenceRows.filter((row) => row?.pluginId === pluginId),
    contributions,
    usage: usageSummary?.entries?.find((entry) => entry.pluginId === pluginId) ?? null,
    // `undefined` — the field absent — is what an older host looks like, and
    // the rung reads it as "nobody could check". `null` is a host that HAS the
    // action and reports nothing for this plugin.
    webhookIngress: ingress === null
      ? undefined
      : ingress.find((row) => row.pluginId === pluginId) ?? null,
  };
}

async function runPluginDoctor(
  args: string[],
  format: OutputFormat,
  deps: PluginCommandDeps | undefined,
): Promise<PluginCliResult> {
  const pluginId = requirePluginId(args[0], "ade plugin doctor <id>");
  const pluginsRoot = resolvePluginsRoot();
  const record = readPluginInstallRecords(pluginsRoot).get(pluginId) ?? null;
  const parsed = readPluginManifestAt(path.join(pluginsRoot, pluginId));
  const live = await readPluginDoctorLive(pluginId, parsed.manifest, deps?.invokeAction);

  const report = buildPluginDoctorReport({
    pluginId,
    record,
    manifest: parsed.manifest,
    // A plugin that is not installed here has no manifest to be wrong about;
    // reporting "plugin.json is missing" for it would answer a question the
    // "Installed here" line already answers better.
    manifestErrors: record ? parsed.errors : [],
    manifestWarnings: record ? parsed.warnings : [],
    live,
    sourcePresent: record?.source.kind === "local"
      ? fs.existsSync(path.resolve(record.source.path))
      : null,
    // The copy ADE loads, not the author's source folder. A page rung that
    // measured the source would pass over a bundle that never got copied.
    installedRoot: path.join(pluginsRoot, pluginId),
  });
  const exitCode = pluginDoctorExitCode(report);
  if (format === "text") return { output: formatPluginDoctorReport(report), exitCode };
  return { output: `${JSON.stringify(report, null, 2)}\n`, exitCode };
}

// ---------------------------------------------------------------------------
// dev — watch a plugin directory, reload on change
// ---------------------------------------------------------------------------

const DEV_DEBOUNCE_MS = 300;

/**
 * Which directory `ade plugin dev` watches.
 *
 * Exported for the test that pins the local-source rule: watching the installed
 * copy of a `local` plugin is a reload loop, because a reload rewrites that copy
 * from the source on every pass.
 */
export function resolveDevTarget(target: string | undefined): { pluginId: string; root: string } {
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
  const record = readPluginInstallRecords(pluginsRoot).get(target);
  if (!record) {
    throw new CliPluginUsageError(`Plugin ${target} is not installed on this machine.`);
  }
  // A `local` install watches the folder it came FROM, never the copy under the
  // plugins root. Two reasons, and the second is not optional: a reload
  // re-copies that folder over the installed copy, so watching the copy would
  // watch bytes nobody edits — and every reload would rewrite the very files
  // the watcher is watching, which is a reload loop that never settles.
  const source = record.source.kind === "local" ? path.resolve(record.source.path) : null;
  if (source && fs.existsSync(path.join(source, PLUGIN_MANIFEST_FILE))) return fromDirectory(source);
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
    // The directories a plugin actually changes during development. `page` is
    // here for the same reason `panels` is: on a platform without recursive
    // `fs.watch` (a network volume, some Linux setups), a saved page file would
    // otherwise never reload the plugin.
    for (const child of ["panels", "page"]) {
      const directory = path.join(target.root, child);
      if (fs.existsSync(directory)) watch(directory, false);
    }
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
  doctor: { kind: "daemon", run: (args, format, deps) => runPluginDoctor(args, format, deps) },
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
