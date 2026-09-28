import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "./errors.js";
import { readStoredMcpServers, type StoredMcpServerConfig } from "./mcpHeaders.js";
import type { PermissionPreset, ThreadPermissionPolicy } from "./permissions.js";
import type { AgentChatInstructions, AgentChatSettingSources } from "./types.js";

/**
 * Durable `key -> sessionId` map at `<home>/threads.json`.
 *
 * This is what makes threads *named*: an app reopens `"support-bot"` after a
 * restart and gets the same conversation back. The file is the SDK's own state,
 * separate from the runtime's database, so a caller can inspect or reset the
 * mapping without touching ADE internals.
 *
 * Writes are atomic (temp file + rename): a crash mid-write must never leave a
 * truncated JSON that loses every mapping the app ever made.
 */

export type ThreadRecord = {
  key: string;
  sessionId: string;
  provider: string;
  model: string;
  /**
   * The catalog model id the thread is bound to, when known. `model` is the
   * provider-native token a `setModel` resolved to, which a recreate cannot
   * always hand back to `create`; the catalog id can.
   */
  modelId?: string;
  createdAt: string;
  lastOpenedAt: string;
  title?: string | null;
  /**
   * Whether this thread asked for `mcpServers` or strict mode when it was
   * created. Recorded so a RESUME can tell "the runtime reported a capability
   * because we requested one" apart from "the runtime volunteered one".
   *
   * Undefined on records written before this field existed, and on chats the
   * SDK did not create — those fall back to trusting the runtime.
   */
  requestedMcp?: boolean;
  /**
   * The MCP request this key was created with (or last refreshed to). Stored
   * so a recreate after the runtime loses the session can rebuild the same
   * tool surface instead of opening a silent tool-less thread under the same
   * name.
   *
   * HEADER VALUES ARE NEVER STORED. A remote server keeps `headerNames` only;
   * the values come back from `refresh.mcpServers` or the client's
   * `mcpHeaders` callback at every create, resume and restart. A file written
   * by an SDK before 0.3 is migrated on first read: values stripped, names
   * kept, file rewritten.
   */
  mcpServers?: Record<string, StoredMcpServerConfig>;
  loadUserMcpServers?: boolean;
  /**
   * The host configuration this key was created with.
   *
   * Stored for the same reason `mcpServers` is: when the runtime has lost the
   * session, `open(key)` recreates it, and a recreate that dropped the
   * instructions, the working directory, or the permission policy would hand
   * the caller a thread with the same name and different behavior — the one
   * outcome a durable key must not produce.
   */
  instructions?: AgentChatInstructions;
  cwd?: string;
  settingSources?: AgentChatSettingSources;
  permissionPolicy?: ThreadPermissionPolicy;
  /**
   * The permission PRESET this key was created with, when it was created with
   * a preset rather than a policy. A recreate and a restart rebind reuse it
   * with the same stored-wins precedence as `permissionPolicy`, so a key
   * created `"default"` cannot be rebuilt `"always-allow"` by whoever names it
   * next. Absent on records written before 0.3 (and whenever a policy is
   * stored): those keep the older rule — the call's `permissions`, then
   * `"default"`.
   */
  permissionPreset?: PermissionPreset;
};

type ThreadStoreFile = {
  version: 1;
  threads: Record<string, ThreadRecord>;
};

const EMPTY: ThreadStoreFile = { version: 1, threads: {} };

export class ThreadStore {
  private cache: ThreadStoreFile | null = null;
  /** Single-flight first read, so two early callers do not both migrate and write. */
  private loading: Promise<ThreadStoreFile> | null = null;
  /** Serialises writes so two concurrent `open()` calls cannot clobber. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger: (line: string) => void = () => {},
  ) {}

  static forHome(home: string, logger?: (line: string) => void): ThreadStore {
    return new ThreadStore(path.join(home, "threads.json"), logger);
  }

  get path(): string {
    return this.filePath;
  }

  async all(): Promise<ThreadRecord[]> {
    const file = await this.read();
    return Object.values(file.threads);
  }

  async get(key: string): Promise<ThreadRecord | null> {
    const file = await this.read();
    return file.threads[key] ?? null;
  }

  async put(record: ThreadRecord): Promise<void> {
    await this.mutate((file) => {
      file.threads[record.key] = record;
    });
  }

  async touch(key: string, patch: Partial<ThreadRecord>): Promise<void> {
    await this.mutate((file) => {
      const existing = file.threads[key];
      if (!existing) return;
      file.threads[key] = { ...existing, ...patch, key, lastOpenedAt: new Date().toISOString() };
    });
  }

  async remove(key: string): Promise<void> {
    await this.mutate((file) => {
      delete file.threads[key];
    });
  }

  private read(): Promise<ThreadStoreFile> {
    if (this.cache) return Promise.resolve(this.cache);
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<ThreadStoreFile> {
    try {
      const raw = await fs.promises.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const { file, migrated } = normalize(parsed);
      // The cache is set only after the migration write below. Until then,
      // readers wait on `loading`, so no `mutate()` can write the same temp
      // file at the same time.
      if (migrated) {
        // An SDK before 0.3 wrote MCP header values — bearer tokens — into
        // this file. Take them off disk now rather than on the next unrelated
        // write, which may never come.
        try {
          await this.writeFile(file);
          this.logger(`ade sdk: removed stored MCP header values from ${this.filePath}; only header names are kept`);
        } catch (error) {
          this.logger(
            `ade sdk: could not rewrite ${this.filePath} to remove stored MCP header values (${errorMessage(error)})`,
          );
        }
      }
      this.cache = file;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // A corrupt store must not brick the client: every key would be
        // unreachable forever. Start clean and say so — the runtime sessions
        // still exist and can be re-bound by opening the same keys again.
        this.logger(
          `ade sdk: ${this.filePath} was unreadable (${errorMessage(error)}); starting a new thread map`,
        );
      }
      this.cache = { version: 1, threads: {} };
    }
    return this.cache!;
  }

  private async writeFile(file: ThreadStoreFile): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.promises.rename(tempPath, this.filePath);
  }

  private async mutate(apply: (file: ThreadStoreFile) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const file = await this.read();
      apply(file);
      await this.writeFile(file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }
}

function isStoredInstructions(value: unknown): value is AgentChatInstructions {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentChatInstructions>;
  if (record.mode !== "append" && record.mode !== "replace") return false;
  return typeof record.text === "string" && record.text.length > 0;
}

function isStoredSettingSources(value: unknown): value is AgentChatSettingSources {
  return value === "none" || value === "project" || value === "user" || value === "all";
}

function isStoredPermissionPolicy(value: unknown): value is ThreadPermissionPolicy {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ThreadPermissionPolicy>;
  // `fallback` is the one required field, and a policy that lost it is not a
  // narrower policy — it is a policy with no answer for anything unmatched. Drop
  // it rather than send a shape the engine would reject or, worse, widen.
  return record.fallback === "ask" || record.fallback === "deny";
}

function normalize(value: unknown): { file: ThreadStoreFile; migrated: boolean } {
  if (!value || typeof value !== "object") return { file: { ...EMPTY, threads: {} }, migrated: false };
  const source = value as Partial<ThreadStoreFile>;
  const threads: Record<string, ThreadRecord> = {};
  let migrated = false;
  for (const [key, entry] of Object.entries(source.threads ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Partial<ThreadRecord>;
    if (typeof record.sessionId !== "string" || !record.sessionId) continue;
    const storedMcp = readStoredMcpServers(record.mcpServers);
    if (storedMcp?.migrated) migrated = true;
    threads[key] = {
      key,
      sessionId: record.sessionId,
      provider: typeof record.provider === "string" ? record.provider : "",
      model: typeof record.model === "string" ? record.model : "",
      ...(typeof record.modelId === "string" && record.modelId ? { modelId: record.modelId } : {}),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
      lastOpenedAt:
        typeof record.lastOpenedAt === "string" ? record.lastOpenedAt : new Date(0).toISOString(),
      title: typeof record.title === "string" ? record.title : null,
      // Preserved only when explicitly stored. A legacy record stays undefined
      // rather than defaulting to false, which would wrongly suppress a real
      // capability report for every thread written before this field existed.
      ...(typeof record.requestedMcp === "boolean" ? { requestedMcp: record.requestedMcp } : {}),
      ...(storedMcp ? { mcpServers: storedMcp.servers } : {}),
      ...(typeof record.loadUserMcpServers === "boolean"
        ? { loadUserMcpServers: record.loadUserMcpServers }
        : {}),
      // Each guarded on its own shape rather than copied wholesale: this file
      // is written by an earlier version of the SDK and edited by hand, so a
      // field that does not parse is dropped instead of being replayed onto a
      // create call as garbage.
      ...(isStoredInstructions(record.instructions)
        ? { instructions: record.instructions }
        : {}),
      ...(typeof record.cwd === "string" && record.cwd ? { cwd: record.cwd } : {}),
      ...(isStoredSettingSources(record.settingSources)
        ? { settingSources: record.settingSources }
        : {}),
      ...(isStoredPermissionPolicy(record.permissionPolicy)
        ? { permissionPolicy: record.permissionPolicy }
        : record.permissionPreset === "default" || record.permissionPreset === "always-allow"
          ? { permissionPreset: record.permissionPreset }
          : {}),
    };
  }
  return { file: { version: 1, threads }, migrated };
}
