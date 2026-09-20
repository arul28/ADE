import fs from "node:fs";
import path from "node:path";

import {
  ensurePrivateDirectory,
  forgetSecuredPrivatePath,
  writePrivateFile,
  type PrivateFileSecurityOptions,
} from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { isSafeIdentifier } from "../../../shared/safeIdentifier";
import { credentialStoreProviderForHarness } from "../../../shared/harnessCredentialProviders";
import { readHarnessPresetsFromMachine } from "./harnessPresetSettings";
import type { HarnessPreset } from "../../../shared/harnessPresets";
import type { ApiCredentialSummary } from "../../../shared/types/apiCredentials";

export type HarnessCleanupLogger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type PrivateTreeCleanupOptions = PrivateFileSecurityOptions & {
  rmSync?: (target: string, options: { recursive: true; force: true }) => void;
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
  logger?: HarnessCleanupLogger | null;
};

const WINDOWS_CLEANUP_ATTEMPTS = 5;
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 25;
const WINDOWS_CLEANUP_ERROR_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

function pathEscapesRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * The one spelling of the pre-namespace prefix, so the writer that mints a
 * legacy path and the pruner that must *not* delete one cannot disagree.
 */
export const LEGACY_CREDENTIAL_HOME_PREFIX = "credential-";

/**
 * The on-disk spelling of one id segment.
 *
 * WHY fold case on every platform: Windows and the default macOS filesystem are
 * case-insensitive, so "Work" and "work" resolve to ONE directory there and to
 * two on Linux — the same two credentials would share a home on two platforms
 * and not on the third. Folding here makes the mapping identical everywhere;
 * `apiKeyStore` refuses a new id that collides case-insensitively with an
 * existing one, so folding never merges two credentials that both still exist.
 */
function configHomeSegment(id: string): string {
  return id.toLowerCase();
}

function ownedConfigHome(
  adeHome: string,
  namespace: "preset" | "credential",
  ...segments: readonly string[]
): string {
  if (!segments.length || segments.some((segment) => !isSafeIdentifier(segment))) {
    throw new Error("Unsafe provider-home identifier: use only letters, digits, dot, underscore, and dash.");
  }
  const root = path.resolve(adeHome, "provider-homes", namespace);
  const candidate = path.resolve(root, ...segments.map(configHomeSegment));
  if (pathEscapesRoot(root, candidate)) {
    throw new Error(`Provider-home path escapes ADE's ${namespace} directory.`);
  }
  return candidate;
}

/** `<adeHome>/provider-homes/preset/<presetId>` — one directory per preset. */
export function presetConfigHome(adeHome: string, presetId: string): string {
  return ownedConfigHome(adeHome, "preset", presetId);
}

/**
 * Direct API-key launches live outside the preset namespace, one directory per
 * provider and credential.
 *
 * WHY nested rather than `<provider>-<credentialId>`: the joined form is
 * ambiguous — provider "openai" with credential "compat-work" and provider
 * "openai-compat" with credential "work" both spell `openai-compat-work`, so
 * revoking one key could delete the other one's home.
 */
export function credentialConfigHome(adeHome: string, provider: string, credentialId: string): string {
  return ownedConfigHome(adeHome, "credential", provider, credentialId);
}

/** Homes written by versions that placed direct credentials under preset/. */
function legacyCredentialConfigHome(adeHome: string, provider: string, credentialId: string): string {
  return ownedConfigHome(adeHome, "preset", `${LEGACY_CREDENTIAL_HOME_PREFIX}${provider}-${credentialId}`);
}

/** Homes written by versions that joined provider and credential into one segment. */
function legacyFlatCredentialConfigHome(adeHome: string, provider: string, credentialId: string): string {
  return ownedConfigHome(adeHome, "credential", `${provider}-${credentialId}`);
}

function logCleanupFailure(target: string, error: unknown, attempts: number, logger?: HarnessCleanupLogger | null): void {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  const meta = { target, attempts, ...(code ? { code } : {}) };
  if (logger) {
    logger.warn("chat.harness_private_home_cleanup_failed", meta);
  } else {
    console.warn("chat.harness_private_home_cleanup_failed", meta);
  }
}

/**
 * Delete an ADE-owned private tree without making a locked Windows file block
 * the launch that follows it. Retries are asynchronous so the main launch
 * path stays available; the bounded retry owns only the stale target.
 */
export function removePrivateTree(target: string, options: PrivateTreeCleanupOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const rmSync = options.rmSync ?? ((candidate, rmOptions) => fs.rmSync(candidate, rmOptions));
  const scheduleRetry = options.scheduleRetry ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
  });
  let attempt = 0;

  const remove = (): void => {
    attempt += 1;
    try {
      rmSync(target, { recursive: true, force: true });
      // A re-created directory must be re-secured, so drop the process's
      // "already has an owner-only ACL" memory of this path.
      forgetSecuredPrivatePath(target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = platform === "win32" && typeof code === "string" && WINDOWS_CLEANUP_ERROR_CODES.has(code);
      if (retryable && attempt < WINDOWS_CLEANUP_ATTEMPTS) {
        scheduleRetry(remove, WINDOWS_CLEANUP_RETRY_DELAY_MS);
        return;
      }
      logCleanupFailure(target, error, attempt, options.logger);
    }
  };

  remove();
}

/** Remove preset homes that were left behind after an account-settings deletion. */
export function pruneOrphanedPresetConfigHomes(
  adeHome: string,
  presets: readonly HarnessPreset[],
  options: PrivateTreeCleanupOptions = {},
): void {
  const presetRoot = path.resolve(adeHome, "provider-homes", "preset");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(presetRoot, { withFileTypes: true });
  } catch {
    return;
  }
  // Folded, because that is the spelling `ownedConfigHome` wrote to disk.
  const existingIds = new Set(
    presets
      .map((entry) => entry.id.trim())
      .filter((entry) => isSafeIdentifier(entry))
      .map(configHomeSegment),
  );
  for (const entry of entries) {
    // WHY: releases before the credential namespace used this prefix under
    // preset/. Keep those homes until credential removal can revoke them too.
    if (
      !entry.isDirectory()
      || !isSafeIdentifier(entry.name)
      || entry.name.startsWith(LEGACY_CREDENTIAL_HOME_PREFIX)
      || existingIds.has(configHomeSegment(entry.name))
    ) continue;
    removePrivateTree(presetConfigHome(adeHome, entry.name), options);
  }
}

/**
 * Prune after the account-settings cache has been updated.
 *
 * A cache read can fail transiently, and an empty list is a valid account
 * setting, so only a confirmed list is allowed to delete a private home.
 */
export function pruneOrphanedPresetConfigHomesFromMachine(
  adeHome = resolveMachineAdeLayout().adeDir,
  options: PrivateTreeCleanupOptions = {},
): void {
  const presets = readHarnessPresetsFromMachine(adeHome);
  if (presets === null) return;
  pruneOrphanedPresetConfigHomes(adeHome, presets, options);
}

/**
 * Every preset whose *key* source names this credential.
 *
 * Exported so both the removal path and its test can ask the question once.
 * Matching mirrors the launch path: a key preset without an explicit
 * `source.provider` is stored under the harness's default credential provider.
 */
export function presetsUsingCredential(
  presets: readonly HarnessPreset[],
  provider: string,
  credentialId: string,
): HarnessPreset[] {
  const wantedProvider = provider.trim().toLowerCase();
  const wantedCredentialId = credentialId.trim().toLowerCase();
  return presets.filter((preset) => {
    if (preset.source?.kind !== "key") return false;
    const presetProvider = (preset.source.provider?.trim()
      || credentialStoreProviderForHarness(preset.harness)).toLowerCase();
    return presetProvider === wantedProvider
      && preset.source.credentialId.trim().toLowerCase() === wantedCredentialId;
  });
}

export type CredentialLaunchHomeCleanupOptions = PrivateTreeCleanupOptions & {
  /** Test seam; production reads the same cache the launch path reads. */
  readPresets?: (adeHome: string) => readonly HarnessPreset[] | null;
};

/**
 * Remove every private home that still holds this credential's secret.
 *
 * Three shapes, because a revoked key that stays readable anywhere is the bug:
 * the credential's own home, the two legacy spellings of it, and — the one that
 * used to survive a revoke — the home of every *preset* built on this key,
 * which contains the key verbatim inside `opencode.json` or
 * `.factory/settings.json`.
 */
export function removeCredentialLaunchHome(
  provider: string,
  credentialId: string,
  adeHome = resolveMachineAdeLayout().adeDir,
  options: CredentialLaunchHomeCleanupOptions = {},
): void {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedCredentialId = credentialId.trim();
  if (!isSafeIdentifier(normalizedProvider) || !isSafeIdentifier(normalizedCredentialId)) return;
  const { readPresets, ...cleanup } = options;
  removePrivateTree(credentialConfigHome(adeHome, normalizedProvider, normalizedCredentialId), cleanup);
  // WHY: upgrading must also remove the old shared-namespace home, otherwise a
  // revoked key can remain readable even though new launches use credential/.
  removePrivateTree(legacyCredentialConfigHome(adeHome, normalizedProvider, normalizedCredentialId), cleanup);
  removePrivateTree(legacyFlatCredentialConfigHome(adeHome, normalizedProvider, normalizedCredentialId), cleanup);

  const presets = (readPresets ?? readHarnessPresetsFromMachine)(adeHome);
  if (!presets) return;
  for (const preset of presetsUsingCredential(presets, normalizedProvider, normalizedCredentialId)) {
    if (!isSafeIdentifier(preset.id.trim())) continue;
    removePrivateTree(presetConfigHome(adeHome, preset.id.trim()), cleanup);
  }
}

export type HarnessPresetOpenCodeProvider = {
  id: string;
  block: {
    npm: string;
    name: string;
    options: { baseURL: string; apiKey?: string };
    models: Record<string, Record<string, never>>;
  };
};

export function writeOpenCodePresetConfig(
  configHome: string,
  provider: HarnessPresetOpenCodeProvider,
  security: PrivateFileSecurityOptions = {},
): string {
  ensurePrivateDirectory(configHome, security);
  const configPath = path.join(configHome, "opencode.json");
  writePrivateFile(configPath, `${JSON.stringify({ provider: { [provider.id]: provider.block } }, null, 2)}\n`, security);
  return configPath;
}

export function buildCodexPresetConfigToml(baseUrl: string | undefined): string {
  const resolved = (baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  return [
    "# Written by ADE for a harness preset. Edits here are overwritten on launch.",
    "# ADE never writes to ~/.codex/config.toml; CODEX_HOME points Codex at this",
    "# directory instead, so the user's own Codex sign-in is untouched.",
    'model_provider = "ade"',
    "",
    "[model_providers.ade]",
    'name = "ADE"',
    `base_url = "${resolved}"`,
    'wire_api = "responses"',
    'env_key = "ADE_PRESET_OPENAI_API_KEY"',
    "",
  ].join("\n");
}

export function buildCodexProxyConfigToml(providerFragment: string): string {
  return [
    "# Written by ADE for a harness preset borrowing a subscription through",
    "# ADE's proxy. Edits here are overwritten on launch. ADE never writes to",
    "# ~/.codex/config.toml; CODEX_HOME points Codex at this directory instead.",
    'model_provider = "ade-proxy"',
    "",
    providerFragment.trim(),
    "",
  ].join("\n");
}

export function writeDroidPresetSettings(
  configHome: string,
  credential: ApiCredentialSummary,
  key: string,
  security: PrivateFileSecurityOptions = {},
): void {
  const factoryDir = path.join(configHome, ".factory");
  ensurePrivateDirectory(factoryDir, security);
  const baseUrl = credential.baseUrl?.trim();
  const settingsPath = path.join(factoryDir, "settings.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // A missing or unreadable file is the normal first-launch case.
  }
  const customModels = (credential.models ?? []).map((modelId) => ({
    model_display_name: modelId,
    model: modelId,
    base_url: baseUrl || "https://api.openai.com/v1",
    api_key: key,
    provider: credential.protocol === "anthropic" ? "anthropic" : "generic-chat-completion-api",
    max_tokens: 8192,
  }));
  writePrivateFile(settingsPath, `${JSON.stringify({ ...existing, custom_models: customModels }, null, 2)}\n`, security);
}
