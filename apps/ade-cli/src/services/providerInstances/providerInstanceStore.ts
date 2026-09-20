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
import { resolveClaudeCodeExecutable } from "../../../../desktop/src/main/services/ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../../../../desktop/src/main/services/ai/codexExecutable";
import {
  DEFAULT_PROVIDER_INSTANCE_SETTINGS,
  PROVIDER_INSTANCE_PROVIDERS,
  defaultProviderInstanceId,
  isDefaultProviderInstanceId,
  isProviderInstanceProvider,
  normalizeProviderInstanceAccent,
  type ProviderInstance,
  type ProviderInstanceLoginCommand,
  type ProviderInstanceProvider,
  type ProviderInstanceRegistry,
  type ProviderInstanceSettings,
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
 * What is NOT in this file: credentials. An instance is a directory path plus a
 * label; the provider CLI writes its own tokens inside that directory and ADE
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
  id: string;
  provider: ProviderInstanceProvider;
  label: string;
  accentColor?: string;
  configHome: string;
  createdAt: string;
  account?: { email?: string; plan?: string };
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
    | "refresh";
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
  return {
    id,
    provider,
    label,
    ...(accentColor ? { accentColor } : {}),
    configHome,
    createdAt: createdAt ?? DEFAULT_INSTANCE_CREATED_AT,
    ...(account && (account.email || account.plan) ? { account } : {}),
  };
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
    return provider === "claude"
      ? claudeConfigHome({ env, homeDir })
      : codexConfigHome({ env, homeDir });
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

  function toPublic(stored: StoredInstance, file: RegistryFile): ProviderInstance {
    const signedIn = Boolean(stored.account?.email || stored.account?.plan);
    return {
      id: stored.id,
      provider: stored.provider,
      label: stored.label,
      ...(stored.accentColor ? { accentColor: stored.accentColor } : {}),
      configHome: stored.configHome,
      isDefault: defaultIdFor(stored.provider, file) === stored.id,
      createdAt: stored.createdAt,
      ...(stored.account ? { account: stored.account } : {}),
      signedIn,
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

  function resolveBinary(provider: ProviderInstanceProvider): string {
    if (options.resolveBinary) return options.resolveBinary(provider);
    return provider === "claude"
      ? resolveClaudeCodeExecutable({ env }).path
      : resolveCodexExecutable({ env }).path;
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
      env: providerInstanceEnvPatch(instance),
    };
  }

  function uniqueInstanceId(provider: ProviderInstanceProvider, label: string, file: RegistryFile): string {
    const taken = new Set<string>([
      ...PROVIDER_INSTANCE_PROVIDERS,
      ...file.instances.map((instance) => instance.id),
    ]);
    const base = slugForLabel(label);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 && !taken.has(base)
        ? base
        : `${base}-${randomBytes(3).toString("hex")}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${provider}-${randomBytes(8).toString("hex")}`;
  }

  function create(args: {
    provider: unknown;
    label: unknown;
    accentColor?: unknown;
  }): { instance: ProviderInstance; loginCommand: ProviderInstanceLoginCommand } {
    const provider = requireProvider(args.provider);
    const label = normalizeLabel(args.label);
    const accentColor = normalizeProviderInstanceAccent(args.accentColor);
    const file = readFile();
    const id = uniqueInstanceId(provider, label, file);
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

  function setDefault(id: string): ProviderInstance {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) throw new Error("A provider account id is required.");
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
    if (isDefaultProviderInstanceId(trimmed)) {
      throw new Error("The machine's own provider login cannot be removed; it is where the provider reads its config.");
    }
    if (defaultIdFor(record.provider, file) === trimmed) {
      throw new Error("This account is the default. Make another account the default first.");
    }
    file.instances = file.instances.filter((entry) => entry.id !== trimmed);
    writeFile(file);
    emit({ reason: "remove", provider: record.provider, instanceId: trimmed });
    return { removed: true, configHome: record.configHome };
  }

  function getProviderSettings(provider: ProviderInstanceProvider): ProviderInstanceSettings {
    const file = readFile();
    return { ...DEFAULT_PROVIDER_INSTANCE_SETTINGS, ...(file.settings[provider] ?? {}) };
  }

  function setProviderSettings(
    provider: ProviderInstanceProvider,
    settings: Partial<ProviderInstanceSettings>,
  ): ProviderInstanceSettings {
    const resolved = requireProvider(provider);
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
    return next;
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
    const scopedHome = isDefaultProviderInstanceId(record.id) ? undefined : record.configHome;
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
    getProviderSettings,
    setProviderSettings,
    getPresetBindings,
    hasPresetBinding,
    loginCommand: (id: string): ProviderInstanceLoginCommand => {
      const instance = get(id);
      if (!instance) throw new Error(`No provider account with id ${JSON.stringify(id)}.`);
      return loginCommandFor(instance);
    },
    refreshAccounts,
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
export function providerInstanceEnvPatch(
  instance: { id: string; provider: ProviderInstanceProvider; configHome: string } | null | undefined,
): Record<string, string> {
  if (!instance) return {};
  return providerInstanceLaunchEnv(instance.provider, instance);
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
