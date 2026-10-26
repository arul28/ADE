import { isClaudePromptCacheTtl, type ClaudePromptCacheTtl } from "../../../../desktop/src/shared/claudePromptCache";
import { normalizeCompactionSettings, type ProviderCompactionSettings } from "../../../../desktop/src/shared/compactionSettings";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import {
  claudeConfigHome,
  codexConfigHome,
} from "../../../../desktop/src/main/services/shared/providerConfigHomes";
import { pathsEqual } from "../../../../desktop/src/main/services/shared/pathCompare";
import { isAdeProviderHomePath } from "../../../../desktop/src/shared/parentAgentEnv";
import { resolveMachineAdeDir } from "../projects/machineLayout";
import {
  ensurePrivateDirectory,
  type WindowsAclRunner,
} from "../../lib/trustedWindowsTools";
import {
  readClaudeAccount,
  readCodexAccount,
} from "../../../../desktop/src/main/services/usage/providerAccountIdentity";
import { providerInstanceLaunchEnv } from "../../../../desktop/src/shared/cliLaunch";
import { shouldIsolateEmbeddedProviderLogins } from "../../../../desktop/src/shared/providerLoginIsolation";
import { resolveClaudeCodeExecutable } from "../../../../desktop/src/main/services/ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../../../../desktop/src/main/services/ai/codexExecutable";
import {
  CLAUDE_MAIN_PROMPT_CACHE_TTL_ENV,
  CLAUDE_SUBAGENT_PROMPT_CACHE_TTL_ENV,
  DEFAULT_PROVIDER_INSTANCE_SETTINGS,
  PROVIDER_INSTANCE_ENV_KEY,
  PROVIDER_INSTANCE_PROVIDERS,
  defaultProviderInstanceId,
  isDefaultProviderInstanceId,
  isProviderInstanceProvider,
  normalizeProviderInstanceAccent,
  type ProviderInstance,
  type ProviderInstanceLoginCommand,
  type ProviderInstanceProvider,
  type ProviderInstanceRegistry,
  type ProviderInstanceReplacedAccount,
  type ProviderInstanceSettings,
  type ProviderInstanceSettingsPatch,
} from "../../../../desktop/src/shared/types/providerInstances";

/**
 * The machine's provider accounts, as one JSON file beside `projects.json`.
 *
 * Why a file and not a table: every SQLite table with a primary key in this repo
 * auto-becomes a cr-sqlite CRR and replicates to every paired device (see
 * `kvDb.ts`, `LOCAL_ONLY_CRR_EXCLUDED_TABLES`). An account registry names
 * directories on THIS machine — a path that exists on the laptop is meaningless
 * on the phone, and replicating it would hand every peer a list of config homes
 * it cannot open. The registry is machine-local by nature, so it lives where the
 * other machine-local facts live.
 *
 * What is NOT in this file: credentials. An instance is a directory path plus an
 * id; the provider CLI writes its own tokens inside that directory and ADE
 * never reads or copies them. That is also why `remove` deletes nothing on disk.
 */

const REGISTRY_FILE_NAME = "provider-instances.json";
const REGISTRY_VERSION = 1;
const INSTANCE_HOMES_DIR = "provider-homes";
const MAX_LABEL_LENGTH = 60;

/**
 * The default instance predates the registry — it is whatever login the machine
 * already had — so it has no real creation time. The epoch is the honest stamp
 * and it sorts the default first, which is the order every surface wants.
 */
const DEFAULT_INSTANCE_CREATED_AT = new Date(0).toISOString();

type StoredInstance = {
  compaction?: ProviderCompactionSettings;
  subagentPromptCacheTtl?: "1h";
  mainPromptCacheTtl?: ClaudePromptCacheTtl;
  onExtraUsage?: "stop";
  id: string;
  provider: ProviderInstanceProvider;
  label: string;
  accentColor?: string;
  configHome: string;
  createdAt: string;
  account?: { email?: string; plan?: string };
  /** The login this config home held before a different one replaced it. */
  replacedAccount?: ProviderInstanceReplacedAccount;
};

type RegistryFile = {
  version: number;
  instances: StoredInstance[];
  /** Per provider, which instance id is the default. Absent = the base identity. */
  defaults: Partial<Record<ProviderInstanceProvider, string>>;
  settings: Partial<Record<ProviderInstanceProvider, ProviderInstanceSettings>>;
  /** Preset ids explicitly bound to this machine; absent on older registries. */
  presetBindings: string[];
};

export type ProviderInstanceStoreChange = {
  reason:
    | "create"
    | "remove"
    | "rename"
    | "setDefault"
    | "setAccent"
    | "setSettings"
    | "refresh"
    | "login"
    | "dismissReplaced";
  provider?: ProviderInstanceProvider;
  instanceId?: string;
};

export type CreateProviderInstanceStoreOptions = {
  /** The machine ADE directory (`~/.ade` or `ADE_HOME`). */
  adeDir: string;
  /** Injectable for tests; production reads the real environment. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => Date;
  /** Injectable account readers so a test never needs a real provider login. */
  readAccount?: (
    provider: ProviderInstanceProvider,
    configHome: string,
  ) => Promise<{ email?: string; plan?: string }>;
  /** Injectable binary resolution; production uses the shared CLI resolvers. */
  resolveBinary?: (provider: ProviderInstanceProvider) => string;
  /** Injectable security seams; production applies the current Windows ACL. */
  platform?: NodeJS.Platform;
  aclRunner?: WindowsAclRunner;
  currentWindowsUser?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length ? value.trim() : undefined;
}

/** Ids appear in paths and on the CLI, so they stay to `[a-z0-9-]`. */
function slugForLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug.length ? slug : "account";
}

/**
 * The account a Claude or Codex chat runs on: its recorded account, or the
 * provider's default when it has none or that account was removed (a launch
 * falls back the same way). Null for providers with one login. Throws when
 * the account registry cannot be read.
 */
export function resolveChatInstanceId(provider: string, instanceId: string | null | undefined): string | null {
  if (!isProviderInstanceProvider(provider)) return null;
  return getMachineProviderInstanceStore().resolve(provider, instanceId?.trim() || undefined).instance.id;
}

/** What every surface calls an account: its email, else its id. */
export function providerInstanceDisplayLabel(instance: { id: string; account?: { email?: string } }): string {
  return instance.account?.email?.trim() || instance.id;
}

function normalizeLabel(value: unknown): string {
  const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!label) throw new Error("A provider account needs a label.");
  if (label.length > MAX_LABEL_LENGTH) {
    throw new Error(`A provider account label is at most ${MAX_LABEL_LENGTH} characters.`);
  }
  return label;
}

function requireProvider(value: unknown): ProviderInstanceProvider {
  if (!isProviderInstanceProvider(value)) {
    throw new Error(
      `Unknown provider ${JSON.stringify(value)}. Provider accounts exist for ${PROVIDER_INSTANCE_PROVIDERS.join(" and ")}.`,
    );
  }
  return value;
}

function decodeSettings(value: unknown): ProviderInstanceSettings | undefined {
  if (!isRecord(value)) return undefined;
  return {
    smartBalance: value.smartBalance === true,
    autoStartWindows: value.autoStartWindows === true,
  };
}

function decodeStoredInstance(value: unknown): StoredInstance | null {
  if (!isRecord(value)) return null;
  const id = trimmedString(value.id);
  const provider = value.provider;
  const label = trimmedString(value.label);
  const configHome = trimmedString(value.configHome);
  const createdAt = trimmedString(value.createdAt);
  if (!id || !isProviderInstanceProvider(provider) || !label || !configHome) return null;
  const account = isRecord(value.account)
    ? {
      ...(trimmedString(value.account.email) ? { email: trimmedString(value.account.email)! } : {}),
      ...(trimmedString(value.account.plan) ? { plan: trimmedString(value.account.plan)! } : {}),
    }
    : undefined;
  const accentColor = normalizeProviderInstanceAccent(value.accentColor);
  const replaced = isRecord(value.replacedAccount) ? value.replacedAccount : null;
  const replacedEmail = trimmedString(replaced?.email);
  const replacedPlan = trimmedString(replaced?.plan);
  const replacedAccount: ProviderInstanceReplacedAccount | undefined = replaced && replacedEmail
    ? {
      email: replacedEmail,
      ...(replacedPlan ? { plan: replacedPlan } : {}),
      replacedAt: trimmedString(replaced.replacedAt) ?? DEFAULT_INSTANCE_CREATED_AT,
    }
    : undefined;
  return {
    id,
    provider,
    label,
    ...(accentColor ? { accentColor } : {}),
    ...(isRecord(value.compaction) ? { compaction: normalizeCompactionSettings(value.compaction) } : {}),
    ...(provider === "claude" && value.subagentPromptCacheTtl === "1h" ? { subagentPromptCacheTtl: "1h" as const } : {}),
    ...(provider === "claude" && isClaudePromptCacheTtl(value.mainPromptCacheTtl) ? { mainPromptCacheTtl: value.mainPromptCacheTtl } : {}),
    ...(provider === "claude" && value.onExtraUsage === "stop" ? { onExtraUsage: "stop" as const } : {}),
    configHome,
    createdAt: createdAt ?? DEFAULT_INSTANCE_CREATED_AT,
    ...(account && (account.email || account.plan) ? { account } : {}),
    ...(replacedAccount ? { replacedAccount } : {}),
  };
}

function sameEmail(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/**
 * Which of several accounts signed in to one login owns it; the rest are
 * copies that add no quota and that smart balance skips.
 *
 * The default account owns it when it is one of them and its login works, else
 * the first working login in `holders` order (the base identity, then creation
 * order): a broken login has no quota to share. With no working login, the
 * first holder owns it. The registry's `sameLoginAs` and the usage poller's
 * duplicate filter both use this, so balance counts the account with numbers.
 */
export function sameLoginOwner<T extends { id: string }>(
  holders: readonly T[],
  defaultId: string,
  isBroken: (id: string) => boolean,
): T | undefined {
  const working = holders.filter((holder) => !isBroken(holder.id));
  return working.find((holder) => holder.id === defaultId) ?? working[0] ?? holders[0];
}

function emptyFile(): RegistryFile {
  return {
    version: REGISTRY_VERSION,
    instances: [],
    defaults: {},
    settings: {},
    presetBindings: [],
  };
}

export function createProviderInstanceStore(options: CreateProviderInstanceStoreOptions) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? (() => new Date());
  const registryPath = path.join(options.adeDir, REGISTRY_FILE_NAME);
  const listeners = new Set<(change: ProviderInstanceStoreChange) => void>();

  function emit(change: ProviderInstanceStoreChange): void {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch {
        // A subscriber that throws must not roll back a write that already landed.
      }
    }
  }

  /**
   * The provider's config home as the rest of ADE resolves it today.
   *
   * Recomputed on every read rather than stored, because the base identity IS
   * "wherever this machine's provider config lives right now" — a user who sets
   * `CLAUDE_CONFIG_DIR` in their shell profile moved it, and a frozen copy in
   * the registry would make ADE read one directory and launch against another.
   */
  function baseConfigHome(provider: ProviderInstanceProvider): string {
    if (shouldIsolateEmbeddedProviderLogins(env.ADE_RUNTIME_PROFILE, env)) {
      return path.join(options.adeDir, "provider-homes", provider, "default");
    }
    const baseEnv = inheritsAccountHome(provider) ? { ...env, [PROVIDER_INSTANCE_ENV_KEY[provider]]: undefined } : env;
    return provider === "claude"
      ? claudeConfigHome({ env: baseEnv, homeDir })
      : codexConfigHome({ env: baseEnv, homeDir });
  }

  /**
   * True when this process inherited one ACCOUNT's config home (an agent
   * shell's `CLAUDE_CONFIG_DIR`/`CODEX_HOME` inside ADE's provider homes)
   * rather than the machine's own setting. That is not where the base
   * identity lives, so it is neither the base config home nor read as the
   * base account: reading it recorded a false "replaced account" on the
   * shared registry (2026-10-20).
   */
  function inheritsAccountHome(provider: ProviderInstanceProvider): boolean {
    const value = env[PROVIDER_INSTANCE_ENV_KEY[provider]]?.trim();
    return Boolean(value && isAdeProviderHomePath(value, options.adeDir));
  }

  function readFile(): RegistryFile {
    let raw: string;
    try {
      raw = fs.readFileSync(registryPath, "utf8");
    } catch {
      return emptyFile();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A torn or hand-edited file must not wedge every provider launch. The
      // machine still has its base identity, so an unreadable registry degrades
      // to "one default account per provider" rather than to an error.
      return emptyFile();
    }
    if (!isRecord(parsed)) return emptyFile();
    const instances: StoredInstance[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(parsed.instances) ? parsed.instances : []) {
      const decoded = decodeStoredInstance(entry);
      if (!decoded || seen.has(decoded.id)) continue;
      seen.add(decoded.id);
      instances.push(decoded);
    }
    const defaults: RegistryFile["defaults"] = {};
    if (isRecord(parsed.defaults)) {
      for (const provider of PROVIDER_INSTANCE_PROVIDERS) {
        const id = trimmedString(parsed.defaults[provider]);
        if (id) defaults[provider] = id;
      }
    }
    const settings: RegistryFile["settings"] = {};
    if (isRecord(parsed.settings)) {
      for (const provider of PROVIDER_INSTANCE_PROVIDERS) {
        const decoded = decodeSettings(parsed.settings[provider]);
        if (decoded) settings[provider] = decoded;
      }
    }
    const presetBindings = Array.isArray(parsed.presetBindings)
      ? [...new Set(parsed.presetBindings.filter((value): value is string => Boolean(trimmedString(value))).map((value) => value.trim()))]
      : [];
    return { version: REGISTRY_VERSION, instances, defaults, settings, presetBindings };
  }

  function writeFile(file: RegistryFile): void {
    fs.mkdirSync(options.adeDir, { recursive: true });
    writeFileAtomic(registryPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  /** The persisted record for the base identity, or a synthesized one. */
  function baseInstanceRecord(provider: ProviderInstanceProvider, file: RegistryFile): StoredInstance {
    const stored = file.instances.find((instance) => instance.id === provider);
    const configHome = baseConfigHome(provider);
    if (stored) return { ...stored, provider, configHome };
    return {
      id: defaultProviderInstanceId(provider),
      provider,
      label: "Default",
      configHome,
      createdAt: DEFAULT_INSTANCE_CREATED_AT,
    };
  }

  function defaultIdFor(provider: ProviderInstanceProvider, file: RegistryFile): string {
    const pointer = file.defaults[provider];
    if (!pointer) return defaultProviderInstanceId(provider);
    const exists = pointer === provider
      || file.instances.some((instance) => instance.id === pointer && instance.provider === provider);
    // A pointer at a removed account is not an error state to surface — the
    // account is gone, so the base identity is the answer, which is the same
    // rule a session with a stale `instanceId` follows.
    return exists ? pointer : defaultProviderInstanceId(provider);
  }

  /**
   * Accounts whose saved login stopped working, by instance id, as the usage
   * poller last read them. In memory only: the poller reads every account
   * again on its next pass, so a restart re-learns it within one poll.
   */
  const brokenLogins = new Set<string>();

  /**
   * Records whether one account's saved login works. The config home keeps the
   * account's email after the provider CLI clears a broken login, so the email
   * alone said "signed in" for an account that could not run a chat.
   */
  function setLoginBroken(id: string, broken: boolean): void {
    if (brokenLogins.has(id) === broken) return;
    if (broken) brokenLogins.add(id);
    else brokenLogins.delete(id);
    const record = get(id);
    if (record) emit({ reason: "login", provider: record.provider, instanceId: id });
  }

  function toPublic(stored: StoredInstance, file: RegistryFile): ProviderInstance {
    const known = Boolean(stored.account?.email || stored.account?.plan);
    const loginBroken = known && brokenLogins.has(stored.id);
    const signedIn = known && !loginBroken;
    const siblings = allRecords(file).filter((record) => record.provider === stored.provider);
    // Two config homes signed in to one email are one login and one quota.
    const holders = stored.account?.email
      ? siblings.filter((record) => sameEmail(record.account?.email, stored.account?.email))
      : [];
    const owner = sameLoginOwner(holders, defaultIdFor(stored.provider, file), (id) => brokenLogins.has(id));
    const sameLoginAs = owner && owner.id !== stored.id ? owner.id : undefined;
    // A replaced login another account holds again is not lost.
    const replacedAccount = stored.replacedAccount
      && !siblings.some((record) => sameEmail(record.account?.email, stored.replacedAccount?.email))
      ? stored.replacedAccount
      : undefined;
    return {
      id: stored.id,
      ...(stored.compaction ? { compaction: stored.compaction } : {}),
      ...(stored.subagentPromptCacheTtl ? { subagentPromptCacheTtl: stored.subagentPromptCacheTtl } : {}),
      ...(stored.mainPromptCacheTtl ? { mainPromptCacheTtl: stored.mainPromptCacheTtl } : {}),
      ...(stored.onExtraUsage ? { onExtraUsage: stored.onExtraUsage } : {}),
      provider: stored.provider,
      // An account is named by its login, not by a name someone typed: the
      // email once it has signed in, its id until then.
      label: providerInstanceDisplayLabel(stored),
      ...(stored.accentColor ? { accentColor: stored.accentColor } : {}),
      configHome: stored.configHome,
      isDefault: defaultIdFor(stored.provider, file) === stored.id,
      createdAt: stored.createdAt,
      ...(stored.account ? { account: stored.account } : {}),
      signedIn,
      ...(loginBroken ? { loginBroken: true } : {}),
      ...(sameLoginAs ? { sameLoginAs } : {}),
      ...(replacedAccount ? { replacedAccount } : {}),
    };
  }

  /**
   * Every instance, base identities first, then creation order.
   *
   * The base identity is synthesized here rather than written on first boot so
   * an ADE that has never created an account and one that has both describe the
   * same machine — there is no migration, and deleting the registry file is a
   * complete reset rather than a data loss.
   */
  function allRecords(file: RegistryFile): StoredInstance[] {
    const records: StoredInstance[] = [];
    for (const provider of PROVIDER_INSTANCE_PROVIDERS) {
      records.push(baseInstanceRecord(provider, file));
      for (const instance of file.instances) {
        if (instance.provider !== provider || instance.id === provider) continue;
        records.push(instance);
      }
    }
    return records;
  }

  function list(provider?: ProviderInstanceProvider): ProviderInstance[] {
    const file = readFile();
    return allRecords(file)
      .filter((record) => !provider || record.provider === provider)
      .map((record) => toPublic(record, file));
  }

  function get(id: string): ProviderInstance | null {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) return null;
    const file = readFile();
    const record = allRecords(file).find((entry) => entry.id === trimmed);
    return record ? toPublic(record, file) : null;
  }

  function getDefault(provider: ProviderInstanceProvider): ProviderInstance {
    const file = readFile();
    const id = defaultIdFor(provider, file);
    const record = allRecords(file).find((entry) => entry.id === id)
      ?? baseInstanceRecord(provider, file);
    return toPublic(record, file);
  }

  /**
   * The instance a caller asked for, or the provider's default when that id no
   * longer names anything. One resolution rule, shared by chat launch, the PTY
   * resume path and the usage poller, so a removed account cannot mean three
   * different things.
   */
  function resolve(
    provider: ProviderInstanceProvider,
    instanceId: string | null | undefined,
  ): { instance: ProviderInstance; fellBack: boolean } {
    const requested = instanceId?.trim();
    if (requested) {
      const found = get(requested);
      if (found && found.provider === provider) return { instance: found, fellBack: false };
      return { instance: getDefault(provider), fellBack: true };
    }
    return { instance: getDefault(provider), fellBack: false };
  }

  /**
   * ADE's pinned copy of the provider CLI (the strict resolver: dev/test
   * override, pinned download, checkout copy, previous pin). Before this
   * machine has one, the bare command name, as a placeholder only: nothing ADE
   * runs spawns it. The login runner, sign-out and ADE terminals replace it
   * with the pinned copy, waiting for its download or reporting why there is
   * none; never a CLI from the PATH.
   */
  function resolveBinary(provider: ProviderInstanceProvider): string {
    if (options.resolveBinary) return options.resolveBinary(provider);
    const pinned = provider === "claude"
      ? resolveClaudeCodeExecutable({ env }).path
      : resolveCodexExecutable({ env }).path;
    return pinned || provider;
  }

  /**
   * The exact command that signs THIS account in.
   *
   * ADE does not drive the provider's OAuth flow: it hands back argv plus the
   * one env var that points the provider CLI at this instance's config home, so
   * the login lands in the right directory whether it runs in an ADE terminal
   * or the user's own shell. `env` is a patch — the caller keeps its own
   * environment and never has `HOME` rewritten under it.
   */
  function loginCommandFor(instance: ProviderInstance): ProviderInstanceLoginCommand {
    return {
      command: resolveBinary(instance.provider),
      args: instance.provider === "claude" ? ["auth", "login"] : ["login"],
      // The base identity signs in wherever the environment already points;
      // naming the default directory explicitly would file the credential
      // under a key the plain CLI never reads (see `isBaseProviderInstance`).
      env: providerInstanceEnvPatch(instance, {
        allowDefaultConfigHome: shouldIsolateEmbeddedProviderLogins(env.ADE_RUNTIME_PROFILE, env),
      }),
    };
  }

  /** The provider CLI's own sign-out; the default is refused like `remove`. */
  function logoutCommandFor(id: string): { instance: ProviderInstance; command: ProviderInstanceLoginCommand } {
    const instance = get(id);
    if (!instance) throw new Error(`No provider account with id ${JSON.stringify(id)}.`);
    if (instance.isDefault) throw new Error("This account is the default. Make another account the default first.");
    const args = instance.provider === "claude" ? ["auth", "logout"] : ["logout"];
    return { instance, command: { ...loginCommandFor(instance), args } };
  }

  function uniqueInstanceId(provider: ProviderInstanceProvider, label: string | null, file: RegistryFile): string {
    const taken = new Set<string>([
      ...PROVIDER_INSTANCE_PROVIDERS,
      ...file.instances.map((instance) => instance.id),
    ]);
    // A removed account's config home stays on disk with its old login and
    // history, so its id is never handed to a new account.
    const free = (candidate: string): boolean =>
      !taken.has(candidate) && !fs.existsSync(path.join(options.adeDir, INSTANCE_HOMES_DIR, provider, candidate));
    // No name: the next short id an agent can type (`claude-2`, `claude-3`).
    if (!label) {
      for (let index = 2; index < 1000; index += 1) {
        const candidate = `${provider}-${index}`;
        if (free(candidate)) return candidate;
      }
      return `${provider}-${randomBytes(8).toString("hex")}`;
    }
    const base = slugForLabel(label);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
      // The same rule as an unnamed account: a removed account's home stays on
      // disk with its login, so a typed label (an older phone or script) must
      // not pick that id back up either.
      if (free(candidate)) return candidate;
    }
    return `${provider}-${randomBytes(8).toString("hex")}`;
  }

  function create(args: {
    provider: unknown;
    /**
     * Optional, and only shapes the id: accounts are shown by their email.
     * Older phones and scripts still send one.
     */
    label?: unknown;
    accentColor?: unknown;
  }): { instance: ProviderInstance; loginCommand: ProviderInstanceLoginCommand } {
    const provider = requireProvider(args.provider);
    const typedLabel = typeof args.label === "string" && args.label.trim() ? normalizeLabel(args.label) : null;
    const accentColor = normalizeProviderInstanceAccent(args.accentColor);
    const file = readFile();
    const id = uniqueInstanceId(provider, typedLabel, file);
    const label = typedLabel ?? id;
    const configHome = path.join(options.adeDir, INSTANCE_HOMES_DIR, provider, id);
    // 0o700: the provider CLI is about to write its own credentials in here.
    // Use the same best-effort POSIX and owner-only Windows policy as every
    // other ADE-private home; a read-only chmod must not make account creation
    // fail after the directory was created with the requested mode.
    ensurePrivateDirectory(configHome, {
      platform: options.platform,
      aclRunner: options.aclRunner,
      currentUser: options.currentWindowsUser,
    });
    const record: StoredInstance = {
      id,
      provider,
      label,
      ...(accentColor ? { accentColor } : {}),
      configHome,
      createdAt: now().toISOString(),
    };
    file.instances = [...file.instances, record];
    writeFile(file);
    emit({ reason: "create", provider, instanceId: id });
    const instance = toPublic(record, file);
    return { instance, loginCommand: loginCommandFor(instance) };
  }

  function mutateRecord(
    id: string,
    reason: ProviderInstanceStoreChange["reason"],
    apply: (record: StoredInstance) => StoredInstance,
  ): ProviderInstance {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) throw new Error("A provider account id is required.");
    const file = readFile();
    const existing = allRecords(file).find((entry) => entry.id === trimmed);
    if (!existing) throw new Error(`No provider account with id ${JSON.stringify(trimmed)}.`);
    const next = apply(existing);
    const index = file.instances.findIndex((entry) => entry.id === trimmed);
    if (index >= 0) file.instances[index] = next;
    else file.instances = [...file.instances, next];
    writeFile(file);
    emit({ reason, provider: next.provider, instanceId: next.id });
    return toPublic(next, file);
  }

  /**
   * Kept for older phones, which still offer Rename. The stored name is no
   * longer shown anywhere: an account reads as its email.
   */
  function rename(id: string, label: unknown): ProviderInstance {
    const nextLabel = normalizeLabel(label);
    return mutateRecord(id, "rename", (record) => ({ ...record, label: nextLabel }));
  }

  function setAccent(id: string, accentColor: string | null): ProviderInstance {
    const normalized = accentColor === null ? undefined : normalizeProviderInstanceAccent(accentColor);
    if (accentColor !== null && !normalized) {
      throw new Error("An accent colour must be a #rrggbb hex string.");
    }
    return mutateRecord(id, "setAccent", (record) => {
      const next = { ...record };
      if (normalized) next.accentColor = normalized;
      else delete next.accentColor;
      return next;
    });
  }

  /**
   * Accounts whose provider CLI logout is running. The logout takes seconds,
   * and an account made the default meanwhile would come out signed out.
   */
  const signingOut = new Set<string>();

  function setDefault(id: string): ProviderInstance {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) throw new Error("A provider account id is required.");
    if (signingOut.has(trimmed)) throw new Error("This account is being signed out. Try again in a moment.");
    const file = readFile();
    const record = allRecords(file).find((entry) => entry.id === trimmed);
    if (!record) throw new Error(`No provider account with id ${JSON.stringify(trimmed)}.`);
    if (isDefaultProviderInstanceId(trimmed)) delete file.defaults[record.provider];
    else file.defaults[record.provider] = trimmed;
    writeFile(file);
    emit({ reason: "setDefault", provider: record.provider, instanceId: trimmed });
    return toPublic(record, file);
  }

  /**
   * Forget an account. Nothing on disk is deleted.
   *
   * The config home holds the provider's own credentials, written by the
   * provider's own CLI. ADE did not create that login and cannot revoke it, so
   * deleting the directory would destroy a session the user can still use from
   * their shell while ADE reports it as merely "removed" — a destructive action
   * behind a non-destructive word. The directory stays; the path is returned so
   * a caller can tell the user exactly what is still there.
   */
  function remove(id: string): { removed: boolean; configHome: string } {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) throw new Error("A provider account id is required.");
    const file = readFile();
    const record = allRecords(file).find((entry) => entry.id === trimmed);
    if (!record) throw new Error(`No provider account with id ${JSON.stringify(trimmed)}.`);
    // A second removal racing the first one's sign-out must not report success.
    if (signingOut.has(trimmed)) throw new Error("This account is already being signed out.");
    if (isDefaultProviderInstanceId(trimmed)) {
      throw new Error("The machine's own provider login cannot be removed; it is where the provider reads its config.");
    }
    if (defaultIdFor(record.provider, file) === trimmed) {
      throw new Error("This account is the default. Make another account the default first.");
    }
    file.instances = file.instances.filter((entry) => entry.id !== trimmed);
    writeFile(file);
    // An instance id can be reused (an older label slug is minted again when
    // the same label comes back), so a stale entry here would report
    // the fresh account as signed out until its next poll.
    brokenLogins.delete(trimmed);
    emit({ reason: "remove", provider: record.provider, instanceId: trimmed });
    return { removed: true, configHome: record.configHome };
  }

  /** Forget the login an account held before a different sign-in replaced it. */
  function dismissReplaced(id: string): ProviderInstance {
    return mutateRecord(id, "dismissReplaced", (record) => {
      const next = { ...record };
      delete next.replacedAccount;
      return next;
    });
  }

  function getProviderSettings(provider: ProviderInstanceProvider): ProviderInstanceSettings {
    const file = readFile();
    return { ...DEFAULT_PROVIDER_INSTANCE_SETTINGS, ...(file.settings[provider] ?? {}) };
  }

  function setProviderSettings(
    provider: ProviderInstanceProvider,
    settings: ProviderInstanceSettingsPatch,
    instanceId?: string,
  ): ProviderInstanceSettings {
    const resolved = requireProvider(provider);
    const patchesProvider = typeof settings?.smartBalance === "boolean" || typeof settings?.autoStartWindows === "boolean";
    let accountCompaction: { compaction?: ProviderCompactionSettings } | null = null;
    if (instanceId) {
      const account = get(instanceId);
      if (!account || account.provider !== resolved) throw new Error("Provider account does not match this setting.");
      const updated = mutateRecord(instanceId, "setSettings", (record) => {
        const next = { ...record };
        // A patch that names one account setting must not clear the other.
        if (Object.hasOwn(settings, "compaction")) {
          if (settings.compaction == null) delete next.compaction;
          else next.compaction = normalizeCompactionSettings(settings.compaction);
        }
        if (Object.hasOwn(settings, "subagentPromptCacheTtl")) {
          if (resolved === "claude" && settings.subagentPromptCacheTtl === "1h") next.subagentPromptCacheTtl = "1h";
          else delete next.subagentPromptCacheTtl;
        }
        if (Object.hasOwn(settings, "mainPromptCacheTtl")) {
          if (resolved === "claude" && isClaudePromptCacheTtl(settings.mainPromptCacheTtl)) next.mainPromptCacheTtl = settings.mainPromptCacheTtl;
          else delete next.mainPromptCacheTtl;
        }
        if (Object.hasOwn(settings, "onExtraUsage")) {
          if (resolved === "claude" && settings.onExtraUsage === "stop") next.onExtraUsage = "stop";
          else delete next.onExtraUsage;
        }
        return next;
      });
      // One patch can carry account settings and provider settings; the
      // provider part is applied below, not dropped.
      if (!patchesProvider) return { ...getProviderSettings(resolved), compaction: updated.compaction };
      accountCompaction = { compaction: updated.compaction };
    } else {
      // An account setting with no account would be dropped and reported as saved.
      if (Object.hasOwn(settings, "subagentPromptCacheTtl")) {
        throw new Error("The subagent cache setting needs a provider account id.");
      }
      if (Object.hasOwn(settings, "onExtraUsage")) {
        throw new Error("The extra usage setting needs a provider account id.");
      }
    }
    if (Object.hasOwn(settings, "mainPromptCacheTtl")) {
      throw new Error("The main chat cache setting needs a provider account id.");
    }
    const file = readFile();
    const current = { ...DEFAULT_PROVIDER_INSTANCE_SETTINGS, ...(file.settings[resolved] ?? {}) };
    const next: ProviderInstanceSettings = {
      smartBalance: typeof settings?.smartBalance === "boolean" ? settings.smartBalance : current.smartBalance,
      autoStartWindows:
        typeof settings?.autoStartWindows === "boolean" ? settings.autoStartWindows : current.autoStartWindows,
    };
    file.settings[resolved] = next;
    writeFile(file);
    emit({ reason: "setSettings", provider: resolved });
    return accountCompaction ? { ...next, ...accountCompaction } : next;
  }

  /**
   * Who is signed in inside one account's config home.
   *
   * The base identity is read WITHOUT a `configHome`, on purpose. Passing one
   * narrows Claude's candidate list to `<configHome>/.claude.json` alone — and
   * a normal install records `oauthAccount` in `~/.claude.json`, beside the
   * directory rather than inside it. Handing the base identity its own resolved
   * path therefore reports every default install as signed out. Absent means
   * "resolve this machine's account the way ADE always has", which is exactly
   * what the base identity is.
   */
  async function readAccountFor(
    record: Pick<StoredInstance, "id" | "provider" | "configHome">,
  ): Promise<{ readable: boolean; account: { email?: string; plan?: string } }> {
    const provider = record.provider;
    // The base identity's reader follows the process env, which here names
    // another account; "unreadable" keeps what was known.
    if (isDefaultProviderInstanceId(record.id)
      && !options.readAccount
      && !shouldIsolateEmbeddedProviderLogins(env.ADE_RUNTIME_PROFILE, env)
      && inheritsAccountHome(provider)) {
      return { readable: false, account: {} };
    }
    const scopedHome = isDefaultProviderInstanceId(record.id)
      ? shouldIsolateEmbeddedProviderLogins(env.ADE_RUNTIME_PROFILE, env) ? baseConfigHome(provider) : undefined
      : record.configHome;
    try {
      const account = options.readAccount
        ? await options.readAccount(provider, record.configHome)
        : provider === "claude"
          ? await readClaudeAccount(homeDir, scopedHome)
          : await readCodexAccount(homeDir, scopedHome);
      return { readable: true, account };
    } catch {
      // An unreadable config is not a sign-out; keep whatever was known.
      return { readable: false, account: {} };
    }
  }

  /**
   * Re-read every instance's config home and record who is signed in there.
   *
   * Writes (and emits) only when something actually changed, so a poll loop
   * calling this on a cadence does not rewrite the file every cycle.
   */
  async function refreshAccounts(provider?: ProviderInstanceProvider): Promise<ProviderInstance[]> {
    const file = readFile();
    const records = allRecords(file).filter((record) => !provider || record.provider === provider);
    const reads = await Promise.all(records.map(async (record) => ({
      record,
      read: await readAccountFor(record),
    })));

    let changed = false;
    for (const { record, read } of reads) {
      if (!read.readable) continue;
      const account = read.account;
      const next = {
        ...(account.email ? { email: account.email } : {}),
        ...(account.plan ? { plan: account.plan } : {}),
      };
      const hasAccount = Boolean(next.email || next.plan);
      const previous = record.account;
      const same = (previous?.email ?? undefined) === (next.email ?? undefined)
        && (previous?.plan ?? undefined) === (next.plan ?? undefined);
      if (same) continue;
      changed = true;
      const index = file.instances.findIndex((entry) => entry.id === record.id);
      const updated: StoredInstance = {
        ...record,
        ...(hasAccount ? { account: next } : {}),
      };
      if (!hasAccount) delete updated.account;
      // A different email in the same config home means a sign-in elsewhere
      // (`claude /login` in a shell, for the base identity) replaced this
      // login, and its credentials are gone. Remember it so the panel can offer
      // to sign it back in instead of silently losing an account.
      if (previous?.email && next.email && !sameEmail(previous.email, next.email)) {
        updated.replacedAccount = {
          email: previous.email,
          ...(previous.plan ? { plan: previous.plan } : {}),
          replacedAt: now().toISOString(),
        };
      }
      if (index >= 0) file.instances[index] = updated;
      else file.instances = [...file.instances, updated];
    }
    if (changed) {
      writeFile(file);
      emit({ reason: "refresh", ...(provider ? { provider } : {}) });
    }
    const after = readFile();
    return allRecords(after)
      .filter((record) => !provider || record.provider === provider)
      .map((record) => toPublic(record, after));
  }

  function snapshot(): ProviderInstanceRegistry {
    const file = readFile();
    return {
      instances: allRecords(file).map((record) => toPublic(record, file)),
      settings: {
        claude: { ...DEFAULT_PROVIDER_INSTANCE_SETTINGS, ...(file.settings.claude ?? {}) },
        codex: { ...DEFAULT_PROVIDER_INSTANCE_SETTINGS, ...(file.settings.codex ?? {}) },
      },
    };
  }

  /** Explicit machine-local preset bindings, without exposing their sources. */
  function getPresetBindings(): string[] {
    return [...readFile().presetBindings];
  }

  function hasPresetBinding(id: string): boolean {
    const normalized = typeof id === "string" ? id.trim() : "";
    return normalized.length > 0 && readFile().presetBindings.includes(normalized);
  }

  return {
    registryPath,
    list,
    get,
    getDefault,
    resolve,
    snapshot,
    create,
    remove,
    rename,
    setDefault,
    setAccent,
    dismissReplaced,
    getProviderSettings,
    setProviderSettings,
    getPresetBindings,
    hasPresetBinding,
    loginCommand: (id: string): ProviderInstanceLoginCommand => {
      const instance = get(id);
      if (!instance) throw new Error(`No provider account with id ${JSON.stringify(id)}.`);
      return loginCommandFor(instance);
    },
    /**
     * The provider CLI's own sign-out for one account, run against that
     * account's config home. The default is refused like `remove`: new chats
     * go to it, so it has to stay signed in until another account is the
     * default.
     */
    logoutCommand: (id: string): ProviderInstanceLoginCommand => logoutCommandFor(id).command,
    /**
     * Runs one account's logout with `setDefault` refused for it meanwhile.
     * The default check and the mark happen together, before any await.
     */
    async whileSigningOut<T>(id: string, run: (command: ProviderInstanceLoginCommand) => Promise<T>): Promise<T> {
      const { instance, command } = logoutCommandFor(id);
      if (signingOut.has(instance.id)) throw new Error("This account is already being signed out.");
      signingOut.add(instance.id);
      try {
        return await run(command);
      } finally {
        signingOut.delete(instance.id);
      }
    },
    refreshAccounts,
    setLoginBroken,
    /** Every write emits; returns the unsubscribe. */
    onChange(listener: (change: ProviderInstanceStoreChange) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ProviderInstanceStore = ReturnType<typeof createProviderInstanceStore>;

/**
 * The env patch that points one provider CLI at one account's config home.
 *
 * Always a patch spread onto a copy of the caller's environment — never a
 * mutation of `process.env`, and never a rewritten `HOME`. Rewriting `HOME`
 * would move every other tool's config at the same time; ADE moves exactly the
 * one directory the provider owns.
 */
/**
 * The env that carries one Claude account's prompt cache choices to a Claude
 * process. Each of the two lifetimes (main conversation, subagents) is left
 * out when the account made no choice for it or `env` already states it. Only
 * for a launch that runs on the account's own login — a preset or a stored
 * credential bills somewhere else and must not get it.
 */
export function claudeAccountPromptCacheEnv(
  instanceId: string | null | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const statesSubagent = Boolean(env[CLAUDE_SUBAGENT_PROMPT_CACHE_TTL_ENV]?.trim());
  const statesMain = Boolean(env[CLAUDE_MAIN_PROMPT_CACHE_TTL_ENV]?.trim());
  if (statesSubagent && statesMain) return {};
  try {
    const { subagentPromptCacheTtl, mainPromptCacheTtl } = getMachineProviderInstanceStore().resolve("claude", instanceId).instance;
    return {
      ...(subagentPromptCacheTtl && !statesSubagent ? { [CLAUDE_SUBAGENT_PROMPT_CACHE_TTL_ENV]: subagentPromptCacheTtl } : {}),
      ...(mainPromptCacheTtl && !statesMain ? { [CLAUDE_MAIN_PROMPT_CACHE_TTL_ENV]: mainPromptCacheTtl } : {}),
    };
  } catch {
    // An unreadable registry must not stop a launch; Claude Code's default applies.
    return {};
  }
}

/**
 * True when this Claude account's owner chose to stop a turn that draws on
 * extra usage. An unreadable registry answers false: Claude Code's own
 * behavior (continue) applies.
 */
export function claudeAccountStopsOnExtraUsage(instanceId: string | null | undefined): boolean {
  try {
    return getMachineProviderInstanceStore().resolve("claude", instanceId).instance.onExtraUsage === "stop";
  } catch {
    return false;
  }
}

export function providerInstanceEnvPatch(
  instance: { id: string; provider: ProviderInstanceProvider; configHome: string } | null | undefined,
  options: { allowDefaultConfigHome?: boolean } = {},
): Record<string, string> {
  if (!instance) return {};
  return providerInstanceLaunchEnv(instance.provider, instance, options);
}

/**
 * One store per machine ADE directory: two stores over one file would clobber
 * each other's writes, since every mutation is read-modify-write.
 */
const shared = new Map<string, ProviderInstanceStore>();

export function getSharedProviderInstanceStore(
  adeDir: string,
  options?: Omit<CreateProviderInstanceStoreOptions, "adeDir">,
): ProviderInstanceStore {
  const existing = [...shared.entries()].find(([key]) => pathsEqual(key, adeDir));
  if (existing) return existing[1];
  const store = createProviderInstanceStore({ adeDir, ...(options ?? {}) });
  shared.set(adeDir, store);
  return store;
}

export function resetSharedProviderInstanceStoresForTests(): void {
  shared.clear();
}

/**
 * The store for THIS machine's ADE home — the one every surface should use.
 *
 * The registry is machine-local, so there is nothing to plumb through the
 * runtime graph: the desktop main process, the daemon's action domain, the PTY
 * service and the usage poller all resolve the same `ADE_HOME` and therefore
 * the same store. Keeping the lookup here (rather than a field on `AdeRuntime`)
 * is what lets a caller in any of those processes read accounts without the
 * service graph being wired for it first.
 */
export function getMachineProviderInstanceStore(
  env: NodeJS.ProcessEnv = process.env,
): ProviderInstanceStore {
  return getSharedProviderInstanceStore(resolveMachineAdeDir(env), { env });
}

/**
 * The provider account a launch should run under, or null when this launch has
 * nothing to point at.
 *
 * Null covers three cases that must all behave identically — no id was asked
 * for, the provider has no config-home identity (everything but Claude and
 * Codex), or the store is unreadable. In all three the CLI inherits whatever
 * config home the environment already names, which is what ADE did before
 * accounts existed.
 *
 * When an id IS asked for and no longer names an account, the store's
 * `resolve` silently substitutes the provider's default. That fallback is
 * deliberate and unannounced: a removed account must not strand a session.
 *
 * It lives beside the store rather than in `ptyService`, because the PTY
 * service, the chat CLI launcher, the RPC server, the sync command service and
 * the harness preset resolver all need the same three-case rule; when it lived
 * in `ptyService` the preset resolver could not import it (the two modules
 * would form a load-time cycle) and kept a second copy.
 */
export function resolveProviderInstanceForLaunch(
  provider: string,
  instanceId: string | null | undefined,
): { id: string; provider: ProviderInstanceProvider; configHome: string } | null {
  const requested = typeof instanceId === "string" ? instanceId.trim() : "";
  if (!requested || !isProviderInstanceProvider(provider)) return null;
  const { instance } = getMachineProviderInstanceStore().resolve(provider, requested);
  if (!instance.configHome?.trim()) return null;
  return { id: instance.id, provider: instance.provider, configHome: instance.configHome };
}
