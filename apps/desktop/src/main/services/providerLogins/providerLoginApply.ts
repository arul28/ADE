/**
 * Apply on an ADE Cloud computer (P5 step 2a): write the sign-in the account
 * picked for each provider into the file its CLI reads, and take it away again
 * when the person removes it or switches it off.
 *
 * Rules every write keeps:
 * - A draft in the same folder, opened `wx` with mode 600, written, synced,
 *   then renamed over the target. The folder is made with mode 700. A failed
 *   write removes the draft. No reader ever sees half a file.
 * - Only the files `isApplyFileAllowed` names. A vault item can come from any
 *   computer of the account, so a path is never taken from it as it is.
 * - Pi's `auth.json` is merged one entry at a time under Pi's own lock (the
 *   `<file>.lock` folder of proper-lockfile). Kimi's config gets one section,
 *   only when it has none. Qwen's settings get only their auth part.
 *   Antigravity's agent settings get only `auth.type` (and `gcp.project` and
 *   `gcp.location` for a business sign-in).
 * - A cloud computer never renews in this step, so every renewing copy is
 *   access-only: its refresh token is taken out (`accessOnlyFile`).
 *
 * `applied.json` records what this computer wrote (paths and 16-hex hashes,
 * never a value), so removal deletes only a file that is still the one ADE
 * wrote. A file the person made on the computer is never deleted.
 *
 * Windows (Part 3): a rename over a file another process holds open fails
 * there (EPERM, EBUSY). Cloud computers are Linux; a Windows target needs the
 * write-in-place fallback of `writeBorrowedFile` with `writePrivateFile`'s
 * owner-only ACL.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ProviderLoginProvider } from "../../../shared/types/providerLogins";
import { writeFileAtomic } from "../state/durableFile";
import { isRecord } from "../shared/utils";
import {
  ANTIGRAVITY_SETTINGS_REL,
  accessOnlyFile,
  accessOnlyPiEntry,
  carryRootDir,
  carryRow,
  isApplyFileAllowed,
  parseAntigravitySettings,
  type CarriedFile,
  type CarryContext,
} from "./providerLoginCarry";
import { carriedFileBytes, loginContentHash, shortHash } from "./providerLoginPayload";

export type AppliedFile = { abs: string; hash: string };

export type AppliedEntry = {
  provider: ProviderLoginProvider;
  /** The vault key of the sign-in, or `key:<id>` for a saved ADE Cloud key. */
  source: string;
  /** The payload's `contentHash`, or the short hash of the saved key: what "the same copy" means. */
  contentHash: string;
  accessOnly: boolean;
  /** False when no refresh field could be taken out (Droid, an unknown Grok shape). */
  renewalSafe: boolean;
  files: AppliedFile[];
  /** `loginContentHash` of what capture reads back from the written files: capture skips these. */
  loginHashes: string[];
  pi?: { authPath: string; slot: string; entryHash: string };
  kimiConfig?: { path: string };
  qwen?: { path: string; partHash: string; envKeys: string[]; wroteProviders: boolean };
  /** The agent settings fields apply wrote, by dotted name, with the short hash of each value. */
  antigravity?: { path: string; fields: Record<string, string> };
  /** The copy's expiry (epoch ms), for the short wait before a turn (step 3a); null when it has none. */
  expiresAt?: number | null;
  appliedAt: number;
};

export type AppliedStateFile = {
  v: 1;
  accountUserId: string | null;
  /** By ADE Cloud place: the provider, or `pi:<sub>`. */
  applied: Record<string, AppliedEntry>;
  /** Env names this brain set from a saved key, with the short hash of the value it set. */
  env: Record<string, string>;
};

export function emptyAppliedState(accountUserId: string | null): AppliedStateFile {
  return { v: 1, accountUserId, applied: {}, env: {} };
}

export function appliedStatePath(adeDir: string): string {
  return path.join(adeDir, "provider-logins", "applied.json");
}

/** What is on disk, whatever account wrote it: an account switch must undo the old account's files first. */
export function readAppliedState(adeDir: string): AppliedStateFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(appliedStatePath(adeDir), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  return {
    v: 1,
    accountUserId: typeof parsed.accountUserId === "string" ? parsed.accountUserId : null,
    applied: isRecord(parsed.applied) ? parsed.applied as Record<string, AppliedEntry> : {},
    env: isRecord(parsed.env) ? parsed.env as Record<string, string> : {},
  };
}

export function writeAppliedState(adeDir: string, state: AppliedStateFile): void {
  const filePath = appliedStatePath(adeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileAtomic(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

// ── writing ───────────────────────────────────────────────────────────

/** Draft, sync, rename: mode 600 in a mode-700 folder. */
export function writePrivateFileAtomic(target: string, data: Buffer): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const draft = path.join(dir, `.${path.basename(target)}.ade-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(draft, "wx", 0o600);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(draft, target);
  } catch (error) {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The draft goes below either way.
      }
    }
    fs.rmSync(draft, { force: true });
    throw error;
  }
}

function readBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Remove a file only while it is still the one ADE wrote. */
function removeIfOurs(file: AppliedFile): "removed" | "changed" | "gone" {
  const current = readBytes(file.abs);
  if (!current) return "gone";
  if (shortHash(current) !== file.hash) return "changed";
  fs.rmSync(file.abs, { force: true });
  return "removed";
}

/** Every file of an applied entry is still the one ADE wrote, or gone. */
export function appliedFilesUnchanged(entry: AppliedEntry): boolean {
  return entry.files.every((file) => {
    const current = readBytes(file.abs);
    return !current || shortHash(current) === file.hash;
  });
}

// ── Pi's lock (proper-lockfile 4.1.2, as Pi takes it) ─────────────────

/** proper-lockfile: a lock folder older than this is stale (the longer of Pi's sync and async limits). */
const PI_LOCK_STALE_MS = 30_000;
const PI_LOCK_TRIES = 50;
const PI_LOCK_WAIT_MS = 20;

/**
 * Run `fn` while holding Pi's lock on `authPath`: the folder `<authPath>.lock`,
 * made with `mkdir` (atomic), as proper-lockfile makes it with `realpath:
 * false`. Pi's own writes wait for it, and it waits for Pi's. A lock folder
 * older than 30 s is a dead process's and is taken over, as proper-lockfile
 * does. No new dependency.
 */
export async function withPiAuthLock<T>(authPath: string, fn: () => T): Promise<T> {
  const lockDir = `${authPath}.lock`;
  fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > PI_LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Released between the mkdir and the stat: try again at once.
        continue;
      }
      if (attempt >= PI_LOCK_TRIES) throw Object.assign(new Error("Pi's auth.json is locked."), { code: "ELOCKED" });
      await new Promise((resolve) => setTimeout(resolve, PI_LOCK_WAIT_MS));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function readJsonObject(file: string): Record<string, unknown> | "missing" | "unreadable" {
  const raw = readBytes(file);
  if (!raw) return "missing";
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : "unreadable";
  } catch {
    return "unreadable";
  }
}

const encodeJson = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

// ── Kimi's config section ─────────────────────────────────────────────

const KIMI_SECTION = "[providers.\"managed:kimi-code\"]";
const KIMI_SECTION_PATTERN = /^\s*\[providers\."managed:kimi-code"\]\s*$/m;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function kimiSectionText(part: Record<string, unknown>): string | null {
  const oauth = isRecord(part.oauth) ? part.oauth : null;
  if (!oauth || oauth.storage !== "file" || typeof oauth.key !== "string") return null;
  const lines = ["", KIMI_SECTION];
  if (typeof part.type === "string") lines.push(`type = ${tomlString(part.type)}`);
  if (typeof part.baseUrl === "string") lines.push(`base_url = ${tomlString(part.baseUrl)}`);
  lines.push("", "[providers.\"managed:kimi-code\".oauth]", `storage = "file"`, `key = ${tomlString(oauth.key)}`);
  if (typeof oauth.oauthHost === "string") lines.push(`oauth_host = ${tomlString(oauth.oauthHost)}`);
  return `${lines.join("\n")}\n`;
}

/** Remove the section ADE appended: from its header to the next table that is not its own. */
function withoutKimiSection(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1]?.trim() ?? null;
    if (header) inside = header === "providers.\"managed:kimi-code\"" || header.startsWith("providers.\"managed:kimi-code\".");
    if (!inside) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}$/, "\n\n");
}

// ── Qwen's auth part ──────────────────────────────────────────────────

type QwenPart = { auth: unknown; env: Record<string, unknown>; modelProviders: unknown };

function qwenPartOf(settings: Record<string, unknown>, envKeys?: readonly string[]): QwenPart {
  const security = isRecord(settings.security) ? settings.security : {};
  const env = isRecord(settings.env) ? settings.env : {};
  const keys = envKeys ?? Object.keys(env);
  return {
    auth: security.auth ?? null,
    env: Object.fromEntries(keys.filter((key) => key in env).map((key) => [key, env[key]])),
    modelProviders: settings.modelProviders ?? null,
  };
}

const qwenPartHash = (part: QwenPart): string => shortHash(JSON.stringify(part));

// ── Antigravity's agent settings ──────────────────────────────────────

const ANTIGRAVITY_AUTH_TYPES = new Set(["oauth-personal", "oauth-business"]);
/** A project id or a location: short, one line. Anything else from a vault item is not written. */
const SETTING_TEXT = /^[^\u0000-\u001f]{1,200}$/;

/** The fields to write, by dotted name: what the agent needs to pick this sign-in's token. */
function antigravityFields(slot: string, parts: Record<string, unknown> | null): Record<string, string> | null {
  const settings = isRecord(parts?.antigravitySettings) ? parts!.antigravitySettings as Record<string, unknown> : null;
  const authType = typeof settings?.authType === "string" && ANTIGRAVITY_AUTH_TYPES.has(settings.authType)
    ? settings.authType
    : slot === "business" ? "oauth-business" : slot === "personal" ? "oauth-personal" : null;
  if (!authType) return null;
  const fields: Record<string, string> = { "auth.type": authType };
  if (authType === "oauth-business") {
    if (typeof settings?.gcpProject === "string" && SETTING_TEXT.test(settings.gcpProject)) fields["gcp.project"] = settings.gcpProject;
    if (typeof settings?.gcpLocation === "string" && SETTING_TEXT.test(settings.gcpLocation)) fields["gcp.location"] = settings.gcpLocation;
  }
  return fields;
}

function readDotted(record: Record<string, unknown>, name: string): unknown {
  const [group, field] = name.split(".") as [string, string];
  const inner = record[group];
  return isRecord(inner) ? inner[field] : undefined;
}

const fieldHash = (record: Record<string, unknown>, name: string): string => shortHash(JSON.stringify(readDotted(record, name) ?? null));

/** Take these dotted fields out, and a group left empty with them. */
function withoutFields(record: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const next = { ...record };
  for (const name of names) {
    const [group, field] = name.split(".") as [string, string];
    if (!isRecord(next[group])) continue;
    const inner = { ...(next[group] as Record<string, unknown>) };
    delete inner[field];
    if (Object.keys(inner).length) next[group] = inner;
    else delete next[group];
  }
  return next;
}

/** The settings file as an object, "missing", or "unreadable" (Hjson the loose read cannot take). */
function readAntigravitySettingsFile(file: string): Record<string, unknown> | "missing" | "unreadable" {
  const raw = readBytes(file);
  if (!raw) return "missing";
  return parseAntigravitySettings(raw.toString("utf8")) ?? "unreadable";
}

// ── the readback that tells capture "this file is the account's" ──────

/** Hash what capture would read back from this provider's files now (one slot for Pi). */
export function readBackLoginHashes(provider: ProviderLoginProvider, slot: string | null, ctx: CarryContext): string[] {
  const row = carryRow(provider);
  if (!row.locate || !row.parse) return [];
  const hashes: string[] = [];
  for (const bundle of row.locate(ctx)) {
    const contents = new Map<string, Buffer>();
    for (const spec of bundle.files) {
      const bytes = readBytes(spec.abs);
      if (bytes) contents.set(spec.rel, bytes);
    }
    if (!contents.size) continue;
    const parsed = row.parse(bundle, contents, ctx);
    if ("unreadable" in parsed) continue;
    for (const login of parsed.logins) {
      if (slot == null || login.slot === slot) hashes.push(loginContentHash(login));
    }
  }
  return hashes;
}

// ── apply one sign-in ─────────────────────────────────────────────────

export type ApplySignIn = {
  place: string;
  provider: ProviderLoginProvider;
  source: string;
  contentHash: string;
  slot: string;
  class: "fixed" | "renewing";
  files: CarriedFile[];
  parts: Record<string, unknown> | null;
  /** The copy's expiry from the vault item, kept for the short wait before a turn. */
  expiresAt?: number | null;
};

export type ApplyResult = { ok: true; entry: AppliedEntry } | { ok: false; reason: "refused_path" | "unreadable_target" | "nothing_to_write" | "write_failed"; code?: string | null };

/**
 * Write one sign-in. A cloud computer is never the owner in step 2a, so a
 * renewing copy is always access-only. The previous entry of the same place
 * (another sign-in of the provider) is replaced file by file: a file it wrote
 * that this one does not write is removed when it is still ADE's.
 */
export async function applySignIn(want: ApplySignIn, previous: AppliedEntry | null, ctx: CarryContext, now: number): Promise<ApplyResult> {
  const accessOnly = want.class === "renewing";
  let renewalSafe = true;
  const files: AppliedFile[] = [];
  const entry: AppliedEntry = {
    provider: want.provider,
    source: want.source,
    contentHash: want.contentHash,
    accessOnly,
    renewalSafe,
    files,
    loginHashes: [],
    expiresAt: want.expiresAt ?? null,
    appliedAt: now,
  };
  try {
    for (const file of want.files) {
      if (!isApplyFileAllowed(want.provider, file.root, file.rel)) return { ok: false, reason: "refused_path" };
      const dir = carryRootDir(file.root, ctx);
      if (!dir) return { ok: false, reason: "refused_path" };
      const abs = path.join(dir, ...file.rel.split("/"));
      let bytes = carriedFileBytes(file);
      if (want.provider === "qwen" && file.rel === "settings.json") {
        // Only the auth part goes in; the rest of the person's settings here stay.
        const source = readJsonObject(abs);
        if (source === "unreadable") return { ok: false, reason: "unreadable_target" };
        let incoming: unknown;
        try {
          incoming = JSON.parse(bytes.toString("utf8"));
        } catch {
          return { ok: false, reason: "unreadable_target" };
        }
        if (!isRecord(incoming)) return { ok: false, reason: "unreadable_target" };
        const part = qwenPartOf(incoming);
        const target = source === "missing" ? {} : { ...source };
        const security = isRecord(target.security) ? { ...target.security } : {};
        if (part.auth != null) security.auth = part.auth;
        target.security = security;
        target.env = { ...(isRecord(target.env) ? target.env : {}), ...part.env };
        const wroteProviders = part.modelProviders != null;
        if (wroteProviders) target.modelProviders = part.modelProviders;
        bytes = encodeJson(target);
        const envKeys = Object.keys(part.env);
        entry.qwen = { path: abs, partHash: qwenPartHash(qwenPartOf(target, envKeys)), envKeys, wroteProviders };
      } else if (accessOnly) {
        const cut = accessOnlyFile(want.provider, file.rel, bytes);
        bytes = cut.data;
        renewalSafe &&= cut.renewalSafe;
      }
      writePrivateFileAtomic(abs, bytes);
      if (!entry.qwen || entry.qwen.path !== abs) files.push({ abs, hash: shortHash(bytes) });
    }

    const piEntry = want.provider === "pi" && isRecord(want.parts?.piEntry) ? want.parts!.piEntry as Record<string, unknown> : null;
    if (want.provider === "pi") {
      if (!piEntry) return { ok: false, reason: "nothing_to_write" };
      const dir = carryRootDir("piAgent", ctx)!;
      const authPath = path.join(dir, "auth.json");
      const written = accessOnly ? accessOnlyPiEntry(piEntry) : piEntry;
      const merged = await withPiAuthLock(authPath, () => {
        const current = readJsonObject(authPath);
        if (current === "unreadable") return false;
        const next = { ...(current === "missing" ? {} : current), [want.slot]: written };
        writePrivateFileAtomic(authPath, encodeJson(next));
        return true;
      });
      if (!merged) return { ok: false, reason: "unreadable_target" };
      entry.pi = { authPath, slot: want.slot, entryHash: shortHash(JSON.stringify(written)) };
    }

    if (want.provider === "kimi" && isRecord(want.parts?.kimiProvider)) {
      const section = kimiSectionText(want.parts!.kimiProvider as Record<string, unknown>);
      const configPath = path.join(carryRootDir("kimiHome", ctx)!, "config.toml");
      const current = readBytes(configPath)?.toString("utf8") ?? null;
      // Written only where there is no such section: the person's own config is never changed.
      if (section && (current == null || !KIMI_SECTION_PATTERN.test(current))) {
        writePrivateFileAtomic(configPath, Buffer.from(`${current ?? ""}${section}`, "utf8"));
        entry.kimiConfig = { path: configPath };
      } else if (previous?.kimiConfig) {
        entry.kimiConfig = previous.kimiConfig;
      }
    }

    if (want.provider === "antigravity") {
      // Only the fields the agent needs to pick this token go in; the rest of the settings here stay.
      const fields = antigravityFields(want.slot, want.parts);
      if (!fields) return { ok: false, reason: "nothing_to_write" };
      const settingsPath = path.join(carryRootDir("geminiHome", ctx)!, ...ANTIGRAVITY_SETTINGS_REL.split("/"));
      const current = readAntigravitySettingsFile(settingsPath);
      if (current === "unreadable") return { ok: false, reason: "unreadable_target" };
      // A business copy replaced by a personal one: a gcp field the earlier copy wrote leaves, if unchanged.
      const names = Object.keys(fields);
      const stale = Object.entries(previous?.antigravity?.fields ?? {})
        .filter(([name, hash]) => !names.includes(name) && current !== "missing" && fieldHash(current, name) === hash)
        .map(([name]) => name);
      let next: Record<string, unknown> = current === "missing" ? {} : withoutFields(current, stale);
      for (const [name, value] of Object.entries(fields)) {
        const [group, field] = name.split(".") as [string, string];
        next = { ...next, [group]: { ...(isRecord(next[group]) ? next[group] as Record<string, unknown> : {}), [field]: value } };
      }
      writePrivateFileAtomic(settingsPath, encodeJson(next));
      entry.antigravity = { path: settingsPath, fields: Object.fromEntries(names.map((name) => [name, fieldHash(next, name)])) };
    }
  } catch (error) {
    return { ok: false, reason: "write_failed", code: (error as NodeJS.ErrnoException)?.code ?? null };
  }

  // A file the previous copy wrote that this one does not (a Kimi slot that moved) goes, if still ADE's.
  for (const old of previous?.files ?? []) {
    if (!files.some((file) => file.abs === old.abs)) removeIfOurs(old);
  }
  entry.renewalSafe = renewalSafe;
  entry.loginHashes = readBackLoginHashes(want.provider, want.provider === "pi" ? want.slot : null, ctx);
  return { ok: true, entry };
}

/** The Codex `auth.json` a saved OpenAI key becomes, in the shape `codex login --with-api-key` writes. */
export function codexKeyFileBytes(token: string): Buffer {
  return encodeJson({ auth_mode: "apikey", OPENAI_API_KEY: token });
}

export function applyCodexKey(source: string, token: string, ctx: CarryContext, previous: AppliedEntry | null, now: number): ApplyResult {
  const abs = path.join(carryRootDir("codexHome", ctx)!, "auth.json");
  const bytes = codexKeyFileBytes(token);
  try {
    writePrivateFileAtomic(abs, bytes);
  } catch (error) {
    return { ok: false, reason: "write_failed", code: (error as NodeJS.ErrnoException)?.code ?? null };
  }
  for (const old of previous?.files ?? []) if (old.abs !== abs) removeIfOurs(old);
  return {
    ok: true,
    entry: {
      provider: "codex",
      source,
      contentHash: shortHash(token),
      accessOnly: false,
      renewalSafe: true,
      files: [{ abs, hash: shortHash(bytes) }],
      loginHashes: [],
      appliedAt: now,
    },
  };
}

/**
 * Take one applied sign-in away: each file only while it is still the one
 * ADE wrote; Pi's entry only while it is unchanged; Kimi's section only when
 * ADE wrote it; Qwen's auth part only while it is unchanged; Antigravity's
 * settings fields only while they are still the values apply wrote.
 */
export async function removeApplied(entry: AppliedEntry): Promise<{ kept: number }> {
  let kept = 0;
  for (const file of entry.files) {
    if (removeIfOurs(file) === "changed") kept += 1;
  }
  if (entry.pi) {
    const { authPath, slot, entryHash } = entry.pi;
    await withPiAuthLock(authPath, () => {
      const current = readJsonObject(authPath);
      if (!isRecord(current) || !(slot in current)) return;
      if (shortHash(JSON.stringify(current[slot])) !== entryHash) {
        kept += 1;
        return;
      }
      const { [slot]: _removed, ...rest } = current;
      writePrivateFileAtomic(authPath, encodeJson(rest));
    });
  }
  if (entry.kimiConfig) {
    const text = readBytes(entry.kimiConfig.path)?.toString("utf8");
    if (text != null && KIMI_SECTION_PATTERN.test(text)) writePrivateFileAtomic(entry.kimiConfig.path, Buffer.from(withoutKimiSection(text), "utf8"));
  }
  if (entry.qwen) {
    const current = readJsonObject(entry.qwen.path);
    if (isRecord(current)) {
      if (qwenPartHash(qwenPartOf(current, entry.qwen.envKeys)) !== entry.qwen.partHash) {
        kept += 1;
      } else {
        const next = { ...current };
        const security = isRecord(next.security) ? { ...next.security } : {};
        delete security.auth;
        if (Object.keys(security).length) next.security = security;
        else delete next.security;
        if (isRecord(next.env)) {
          const env = { ...next.env };
          for (const key of entry.qwen.envKeys) delete env[key];
          if (Object.keys(env).length) next.env = env;
          else delete next.env;
        }
        if (entry.qwen.wroteProviders) delete next.modelProviders;
        writePrivateFileAtomic(entry.qwen.path, encodeJson(next));
      }
    }
  }
  if (entry.antigravity && isRecord(entry.antigravity.fields)) {
    const { path: settingsPath, fields } = entry.antigravity;
    const current = readAntigravitySettingsFile(settingsPath);
    if (isRecord(current)) {
      // Each field still as apply wrote it leaves; one the agent or the person changed stays.
      const unchanged = Object.entries(fields).filter(([name, hash]) => fieldHash(current, name) === hash).map(([name]) => name);
      kept += Object.keys(fields).length - unchanged.length;
      if (unchanged.length) writePrivateFileAtomic(settingsPath, encodeJson(withoutFields(current, unchanged)));
    }
  }
  return { kept };
}

/**
 * The Codex `auth.json` the old cloud boot wrote (`cloudSignInBoot.ts`) from
 * the key the computer was made with: an applied entry for it, so the normal
 * rules manage it from now on (a key removed from the account leaves). Null
 * when the file is not that file.
 */
export function adoptOldCodexKeyFile(bootKey: string, ctx: CarryContext, now: number): AppliedEntry | null {
  const abs = path.join(carryRootDir("codexHome", ctx)!, "auth.json");
  const bytes = readBytes(abs);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.auth_mode !== "apikey" || parsed.OPENAI_API_KEY !== bootKey) return null;
  return {
    provider: "codex",
    source: "key:codex",
    contentHash: shortHash(bootKey),
    accessOnly: false,
    renewalSafe: true,
    files: [{ abs, hash: shortHash(bytes) }],
    loginHashes: [],
    appliedAt: now,
  };
}
