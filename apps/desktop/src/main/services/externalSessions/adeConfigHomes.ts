/**
 * The provider config homes ADE owns under `<ADE_HOME>/provider-homes/`, and
 * which of them can hold a CLI's own sessions. Discovery reads these besides
 * each provider's default home, so a session started on an ADE account,
 * preset, API key or route is found where the CLI wrote it.
 */
import fs from "node:fs";
import path from "node:path";
import { pathKey } from "../shared/pathCompare";
import { HARNESS_CREDENTIAL_STORE_PROVIDER } from "../../../shared/harnessCredentialProviders";
import { readHarnessPresetsFromMachine } from "../chat/harnessPresetSettings";
import { routeConfigHome } from "../chat/harnessPresetConfigHomes";
import { PROVIDER_INSTANCE_ENV_KEY } from "../../../shared/types/providerInstances";
import { isRouteHomeId } from "../../../shared/cliLaunch";
import {
  resolveHomeDir,
  safeReadDir,
  type ExternalSessionConfigHome,
  type ExternalSessionDiscoveryArgs,
} from "./discoveryUtils";

/**
 * The ADE home whose `provider-homes/` tree holds this machine's own config
 * homes for every provider. `ADE_HOME` names it (the launcher and every channel
 * build set it); a hand-started brain without one uses `<home>/.ade`, which is
 * where `resolveMachineAdeDir` would look too.
 */
export function providerAdeHome(args?: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env">): string {
  // Same fallback as every sibling helper: the brain is constructed without an
  // `env` seam, so `process.env` is where its ADE_HOME (a channel home on
  // Alpha/Beta) actually lives.
  const env = args?.env ?? (args?.homeDir ? undefined : process.env);
  const configured = typeof env?.ADE_HOME === "string" ? env.ADE_HOME.trim() : "";
  return path.resolve(configured || path.join(resolveHomeDir(args), ".ade"));
}

function childDirectories(dir: string): string[] {
  return safeReadDir(dir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

/**
 * Whether a preset or credential home belongs to this provider's CLI, judged by
 * the files that CLI itself writes there.
 *
 * The namespace name decides account homes (`provider-homes/claude/<id>` is
 * Claude by definition), but a preset or API-key home is a shared namespace. A
 * Claude home has `.claude.json` plus `projects/`; a Codex home has its auth or
 * thread store, or rollout day folders under `sessions/`. Claude also keeps a
 * `sessions/` registry, so a bare `sessions/` must never classify a home as
 * Codex.
 */
function configHomeBelongsTo(provider: "claude" | "codex", dir: string): boolean {
  const exists = (name: string): boolean => fs.existsSync(path.join(dir, name));
  if (provider === "claude") return exists(".claude.json") || exists("projects");
  // Codex-specific evidence only: another harness's preset home can hold a
  // `config.toml` and a `sessions/` folder too (Grok, Kimi), so neither alone
  // names Codex. A real Codex home has its auth/store files or rollout days.
  // Kimi Code keeps a `session_index.jsonl` too, beside its `workspaces.json`.
  if (exists("auth.json") || (exists("session_index.jsonl") && !exists("workspaces.json"))) return true;
  if (safeReadDir(dir).some((entry) => entry.isFile() && /^state_\d+\.sqlite$/u.test(entry.name))) {
    return true;
  }
  return safeReadDir(path.join(dir, "sessions"))
    .some((entry) => entry.isDirectory() && /^\d{4}$/u.test(entry.name));
}

/**
 * The saved preset ids of this provider, by the folder each one's home has.
 * `harnessPresetConfigHomes` folds the id to lower case for the folder, but a
 * launch finds the preset by its exact id.
 */
function presetIdsByFolder(adeHome: string, provider: string): Map<string, string> {
  return new Map(
    (readHarnessPresetsFromMachine(adeHome) ?? [])
      .filter((preset) => preset.harness === provider)
      .map((preset) => [preset.id.trim().toLowerCase(), preset.id.trim()]),
  );
}

/**
 * Every config directory ADE can be holding this provider's transcripts in,
 * with the launch identity that writes to each.
 *
 * The default home is not the only one: an account gets
 * `<adeHome>/provider-homes/<provider>/<instance>`, a harness preset
 * `provider-homes/preset/<id>`, and a stored API key
 * `provider-homes/credential/<store-provider>/<id>` (Claude keys are filed
 * under `anthropic`, Codex under `openai`). A session started in an ADE
 * terminal lives in one of those homes, so an import has to launch the resume
 * under the same one.
 *
 * An ad-hoc route (`provider-homes/route/<id>`, from `--via` on a chat or a
 * CLI launch) gets a home too. Its folder is a hash of the route, so the home
 * is tagged with that id and the importer names the route from ADE's own
 * launch records.
 */
export function providerConfigHomeDirs(
  provider: "claude" | "codex",
  defaultDir: string,
  args: ExternalSessionDiscoveryArgs = {},
): ExternalSessionConfigHome[] {
  const homes: ExternalSessionConfigHome[] = [{
    dir: path.resolve(defaultDir),
    instanceId: null,
    presetId: null,
    credentialId: null,
  }];
  const adeHome = providerAdeHome(args);
  const providerHomes = path.join(adeHome, "provider-homes");
  for (const dir of childDirectories(path.join(providerHomes, provider))) {
    homes.push({ dir, instanceId: path.basename(dir), presetId: null, credentialId: null });
  }
  const presetDirs = childDirectories(path.join(providerHomes, "preset"))
    .filter((dir) => configHomeBelongsTo(provider, dir));
  const presetIdByFolder = presetDirs.length ? presetIdsByFolder(adeHome, provider) : new Map<string, string>();
  for (const dir of presetDirs) {
    // A folder no saved preset names keeps its own name: the sessions in it
    // still list, and an import resumes them on the CLI's own sign-in.
    const folder = path.basename(dir);
    homes.push({ dir, instanceId: null, presetId: presetIdByFolder.get(folder.toLowerCase()) ?? folder, credentialId: null });
  }
  const credentialNamespace = HARNESS_CREDENTIAL_STORE_PROVIDER[provider];
  for (const dir of childDirectories(path.join(providerHomes, "credential", credentialNamespace))) {
    if (!configHomeBelongsTo(provider, dir)) continue;
    homes.push({ dir, instanceId: null, presetId: null, credentialId: path.basename(dir) });
  }
  for (const dir of childDirectories(path.join(providerHomes, "route"))) {
    if (!configHomeBelongsTo(provider, dir)) continue;
    homes.push({ dir, instanceId: null, presetId: null, credentialId: null, routeHomeId: path.basename(dir) });
  }
  return uniqueConfigHomes(homes);
}

function uniqueConfigHomes(homes: ExternalSessionConfigHome[]): ExternalSessionConfigHome[] {
  return uniqueByPath(homes, (home) => home.dir);
}

/**
 * The first item for each path, compared the way the platform compares paths:
 * an inherited override can name an ADE home that the enumeration lists again.
 */
export function uniqueByPath<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = pathKey(pathOf(item));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The harness CLIs besides Claude and Codex that ADE can run on a config home
 * of its own. A preset or route points each one at the home with one variable
 * (`harnessRouteLaunch.ts`, `harnessKeySourceLaunch.ts`):
 *
 * - Droid: `FACTORY_HOME_OVERRIDE` is a HOME-like root; Droid adds `.factory`.
 *   A preset, a route and a stored Droid key each get one.
 * - Grok, Kimi, Pi: `GROK_HOME`, `KIMI_CODE_HOME`, `PI_CODING_AGENT_DIR` name
 *   the config directory itself. Only a preset or route that routes the CLI
 *   writes one; a plain API key for them is passed in env, so its sessions
 *   stay in the default home.
 *
 * The others never get one: Copilot and Qwen take a preset in env only,
 * OpenCode moves only its config file (sessions stay in its data store),
 * Cursor's CLI takes no preset at all (`harnessPresetCliGate.ts`), and Muse
 * and Antigravity are not preset harnesses.
 */
export type AdeHarnessHomeProvider = "droid" | "grok" | "kimi" | "pi";

/** The variable that points each harness CLI at its config home; its value is the home's `dir`. */
export const ADE_HARNESS_HOME_ENV_KEY: Record<AdeHarnessHomeProvider, string> = {
  droid: "FACTORY_HOME_OVERRIDE",
  grok: "GROK_HOME",
  kimi: "KIMI_CODE_HOME",
  pi: "PI_CODING_AGENT_DIR",
};

export function isAdeHarnessHomeProvider(provider: string): provider is AdeHarnessHomeProvider {
  return Object.prototype.hasOwnProperty.call(ADE_HARNESS_HOME_ENV_KEY, provider);
}

/**
 * The env that runs this provider's CLI in one of ADE's route homes. A resume
 * uses it when Import found a session in a route home that ADE could not name
 * again: the CLI runs there on its own sign-in, where the session is. Null for
 * a provider with no home variable, or for a home that is gone.
 */
export function routeHomeLaunchEnv(
  provider: string,
  routeHomeId: string,
  args: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env"> = {},
): Record<string, string> | null {
  if (!isRouteHomeId(routeHomeId)) return null;
  const key = isAdeHarnessHomeProvider(provider)
    ? ADE_HARNESS_HOME_ENV_KEY[provider]
    : provider === "claude" || provider === "codex"
      ? PROVIDER_INSTANCE_ENV_KEY[provider]
      : null;
  if (!key) return null;
  const dir = routeConfigHome(providerAdeHome(args), routeHomeId);
  return fs.existsSync(dir) ? { [key]: dir } : null;
}

/**
 * Whether a route home is this harness's and holds its sessions. A route home
 * holds no record of its route (its folder is a hash), so its files are the
 * only evidence: Droid's `.factory/sessions`, and Pi's `models.json` (which
 * ADE's route writer puts there) beside its `sessions`. Grok, Kimi and Codex
 * all get a `config.toml`, so those three are told apart by the session
 * folders each CLI makes: Kimi's are `wd_<slug>` workspace ids, Grok's are the
 * percent-encoded cwd, Codex's are years.
 */
function routeHomeBelongsTo(provider: AdeHarnessHomeProvider, dir: string): boolean {
  const exists = (...parts: string[]): boolean => fs.existsSync(path.join(dir, ...parts));
  if (provider === "droid") return exists(".factory", "sessions");
  if (provider === "pi") return exists("models.json") && exists("sessions");
  if (!exists("config.toml")) return false;
  const buckets = safeReadDir(path.join(dir, "sessions"))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return provider === "kimi"
    ? buckets.some((name) => name.startsWith("wd_"))
    : buckets.some(isPercentEncodedAbsolutePath);
}

function isPercentEncodedAbsolutePath(name: string): boolean {
  try {
    const decoded = decodeURIComponent(name);
    return decoded !== name && (path.posix.isAbsolute(decoded) || path.win32.isAbsolute(decoded));
  } catch {
    return false;
  }
}

/**
 * The config homes ADE owns that can hold this harness's CLI sessions, with
 * the launch identity that writes to each. The provider's default home is not
 * in the list; each discoverer reads that one as before.
 *
 * - `preset/<id>`: the saved preset list names each preset's harness, so a
 *   home is this provider's only when its preset says so. A home whose preset
 *   is gone is skipped: deleting a preset deletes its home too.
 * - `route/<id>`: classified by `routeHomeBelongsTo`.
 * - `credential/droid/<id>`: a stored Droid key. No other of these harnesses
 *   writes a credential home.
 *
 * `provider-homes/<provider>/default` is not here either: only an embedded
 * runtime's chats use it (`providerLoginIsolation.ts`), and chats are ADE's own.
 */
export function adeHarnessConfigHomes(
  provider: AdeHarnessHomeProvider,
  args: ExternalSessionDiscoveryArgs = {},
): ExternalSessionConfigHome[] {
  if (args.defaultHomeOnly) return [];
  const adeHome = providerAdeHome(args);
  const providerHomes = path.join(adeHome, "provider-homes");
  const homes: ExternalSessionConfigHome[] = [];
  const presetDirs = childDirectories(path.join(providerHomes, "preset"));
  if (presetDirs.length) {
    const presetIdByFolder = presetIdsByFolder(adeHome, provider);
    for (const dir of presetDirs) {
      const presetId = presetIdByFolder.get(path.basename(dir).toLowerCase());
      if (presetId) homes.push({ dir, presetId });
    }
  }
  for (const dir of childDirectories(path.join(providerHomes, "route"))) {
    if (routeHomeBelongsTo(provider, dir)) homes.push({ dir, routeHomeId: path.basename(dir) });
  }
  if (provider === "droid") {
    const namespace = HARNESS_CREDENTIAL_STORE_PROVIDER.droid;
    for (const dir of childDirectories(path.join(providerHomes, "credential", namespace))) {
      homes.push({ dir, credentialId: path.basename(dir) });
    }
  }
  return uniqueConfigHomes(homes);
}

/** Whether a record's home is one of ADE's preset, API-key or route homes. */
export function isAdeLaunchConfigHome(home: ExternalSessionConfigHome | null | undefined): boolean {
  return Boolean(home?.presetId || home?.credentialId || home?.routeHomeId);
}
