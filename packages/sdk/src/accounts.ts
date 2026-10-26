import { AdeError } from "./errors.js";
export type AccountUsage = {
  state: "ok" | "stale" | "expired" | "signed_out" | "no_reading" | "error";
  readAt: string | null;
  note: string | null;
  windows: Array<{
    type: string;
    label: string;
    percentLeft: number;
    resetsAt: string | null;
    unlimited?: true;
    countLeft?: number;
    countTotal?: number;
  }>;
};

export type AccountInfo = {
  id: string;
  provider: string;
  label: string;
  email?: string;
  plan?: string;
  signedIn: boolean;
  isDefault: boolean;
  loginBroken?: boolean;
  accentColor?: string;
  createdAt?: string;
  usage?: AccountUsage;
};

const ACCOUNT_USAGE_STATES: ReadonlySet<AccountUsage["state"]> = new Set([
  "ok",
  "stale",
  "expired",
  "signed_out",
  "no_reading",
  "error",
]);

export type ApiCredentialInfo = {
  provider: string;
  credentialId: string;
  label: string;
  envVar?: string;
  baseUrl?: string;
  protocol?: "openai-compatible" | "openai-responses" | "anthropic";
  models?: string[];
  source: "store" | "env" | "config";
  createdAt: string;
  updatedAt: string;
  maskedTail?: string;
};

export type SignInStatus = {
  loginId: string;
  instanceId: string;
  provider: string;
  state: "running" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";
  url: string | null;
  awaitingCode: boolean;
  deviceCode?: string;
  output: string;
  email?: string;
  message?: string;
  startedAt: string;
  endedAt?: string;
};

export type SignInHandle = {
  on(event: "update", listener: (status: SignInStatus) => void): () => void;
  submitCode(code: string): Promise<void>;
  cancel(): Promise<void>;
  done: Promise<AccountInfo>;
};

export type AccountManagement = {
  accounts: {
    list(provider?: string): Promise<AccountInfo[]>;
    add(provider: string, options?: { label?: string }): Promise<AccountInfo>;
    remove(id: string): Promise<unknown>;
    rename(id: string, label: string): Promise<AccountInfo>;
    setDefault(id: string): Promise<unknown>;
    signOut(id: string): Promise<unknown>;
    refresh(): Promise<AccountInfo[]>;
    signIn(id: string, options?: { deviceAuth?: boolean }): Promise<SignInHandle>;
  };
  credentials: {
    list(provider?: string): Promise<ApiCredentialInfo[]>;
    add(input: { provider: string; key: string; label: string }): Promise<ApiCredentialInfo>;
    remove(id: string, provider?: string): Promise<unknown>;
    verify(provider: string): Promise<unknown>;
  };
  presets: {
    list(): Promise<Record<string, unknown>[]>;
    add(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    update(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    remove(id: string): Promise<unknown>;
  };
  dispose(): Promise<void>;
};

export type AccountActionCall = (
  domain: "providerAccounts" | "credentials" | "presets",
  action: string,
  args?: unknown,
) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unwrap(value: unknown, key?: string): unknown {
  const row = record(value);
  if (key && row[key] !== undefined) return row[key];
  return row.result ?? value;
}

function rows(value: unknown, key: string): unknown[] {
  const unwrapped = unwrap(value, key);
  if (Array.isArray(unwrapped)) return unwrapped;
  const nested = record(unwrapped)[key];
  return Array.isArray(nested) ? nested : [];
}

function accountInfo(value: unknown): AccountInfo {
  const row = record(withoutSecrets(record(value).instance ?? record(value).account ?? value));
  const account = record(row.account);
  if (typeof row.id !== "string" || typeof row.provider !== "string") {
    throw new AdeError("protocol_error", "The ADE runtime returned an invalid provider account.");
  }
  const email = typeof account.email === "string" ? account.email : row.email;
  const plan = typeof account.plan === "string" ? account.plan : row.plan;
  const usage = accountUsage(row.usage);
  return {
    id: row.id,
    provider: row.provider,
    label: typeof row.label === "string" ? row.label : row.id,
    ...(typeof email === "string" ? { email } : {}),
    ...(typeof plan === "string" ? { plan } : {}),
    signedIn: row.signedIn === true,
    isDefault: row.isDefault === true,
    ...(typeof row.loginBroken === "boolean" ? { loginBroken: row.loginBroken } : {}),
    ...(typeof row.accentColor === "string" ? { accentColor: row.accentColor } : {}),
    ...(typeof row.createdAt === "string" ? { createdAt: row.createdAt } : {}),
    ...(usage ? { usage } : {}),
  };
}

function accountUsage(value: unknown): AccountUsage | undefined {
  const row = record(value);
  if (
    !ACCOUNT_USAGE_STATES.has(row.state as AccountUsage["state"])
    || (row.readAt !== null && typeof row.readAt !== "string")
    || (row.note !== null && typeof row.note !== "string")
    || !Array.isArray(row.windows)
  ) return undefined;

  const windows: AccountUsage["windows"] = [];
  for (const value of row.windows) {
    const window = record(value);
    if (
      typeof window.type !== "string"
      || typeof window.label !== "string"
      || typeof window.percentLeft !== "number"
      || !Number.isFinite(window.percentLeft)
      || (window.resetsAt !== null && typeof window.resetsAt !== "string")
      || (window.unlimited !== undefined && window.unlimited !== true)
      || (window.countLeft !== undefined && (typeof window.countLeft !== "number" || !Number.isFinite(window.countLeft)))
      || (window.countTotal !== undefined && (typeof window.countTotal !== "number" || !Number.isFinite(window.countTotal)))
    ) return undefined;
    windows.push({
      type: window.type,
      label: window.label,
      percentLeft: window.percentLeft,
      resetsAt: window.resetsAt as string | null,
      ...(window.unlimited === true ? { unlimited: true } : {}),
      ...(typeof window.countLeft === "number" ? { countLeft: window.countLeft } : {}),
      ...(typeof window.countTotal === "number" ? { countTotal: window.countTotal } : {}),
    });
  }

  return {
    state: row.state as AccountUsage["state"],
    readAt: row.readAt as string | null,
    note: row.note as string | null,
    windows,
  };
}

const SECRET_FIELDS = new Set(["key", "secret", "token", "value", "apikey", "credentialvalue", "apikeyvalue", "accesstoken", "refreshtoken", "idtoken", "privatekey"]);

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  const row = record(value);
  if (Object.keys(row).length === 0) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(row)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    if (!SECRET_FIELDS.has(normalized) && !/(?:secret|password|credentialvalue|apikey)/.test(normalized)) {
      safe[key] = withoutSecrets(entry);
    }
  }
  return safe;
}

function credentialInfo(value: unknown): ApiCredentialInfo {
  const row = record(withoutSecrets(record(value).credential ?? value));
  if (typeof row.provider !== "string" || typeof row.credentialId !== "string") {
    throw new AdeError("protocol_error", "The ADE runtime returned an invalid credential summary.");
  }
  return row as ApiCredentialInfo;
}

function loginInfo(value: unknown, accountId: string, provider: string): SignInStatus {
  const row = record(record(value).login ?? record(value).status ?? value);
  if (typeof row.loginId !== "string" || !["running", "verifying", "succeeded", "failed", "cancelled", "expired"].includes(String(row.state))) {
    throw new AdeError("protocol_error", "The ADE runtime returned an invalid sign-in status.");
  }
  return {
    loginId: row.loginId,
    instanceId: typeof row.instanceId === "string" ? row.instanceId : accountId,
    provider: typeof row.provider === "string" ? row.provider : provider,
    state: row.state as SignInStatus["state"],
    url: typeof row.url === "string" ? row.url : null,
    awaitingCode: row.awaitingCode === true,
    ...(typeof row.deviceCode === "string" ? { deviceCode: row.deviceCode } : {}),
    output: typeof row.output === "string" ? row.output : "",
    ...(typeof row.email === "string" ? { email: row.email } : {}),
    ...(typeof row.message === "string" ? { message: row.message } : {}),
    startedAt: typeof row.startedAt === "string" ? row.startedAt : new Date().toISOString(),
    ...(typeof row.endedAt === "string" ? { endedAt: row.endedAt } : {}),
  };
}

export function createAccountManagement(call: AccountActionCall, assertUsable: () => void): AccountManagement {
  const handles = new Set<{ dispose(): void; cancelForDispose(): Promise<void> }>();
  const callAccount = (action: string, args?: unknown) => {
    assertUsable();
    return call("providerAccounts", action, args);
  };
  const listAccounts = async (provider?: string): Promise<AccountInfo[]> => {
    const value = await callAccount("list", provider ? { provider } : {});
    return rows(value, "instances").map(accountInfo);
  };
  const accounts: AccountManagement["accounts"] = {
    list: listAccounts,
    add: async (provider, options = {}) => accountInfo(await callAccount("create", { provider, ...options })),
    remove: async (id) => await callAccount("remove", { id }),
    rename: async (id, label) => accountInfo(await callAccount("rename", { id, label })),
    setDefault: async (id) => await callAccount("setDefault", { id }),
    signOut: async (id) => await callAccount("signOut", { id }),
    refresh: async () => {
      const value = await callAccount("refresh", {});
      const entries = rows(value, "instances");
      return entries.length > 0 ? entries.map(accountInfo) : await listAccounts();
    },
    signIn: async (id, options = {}) => {
      const existing = (await listAccounts()).find((account) => account.id === id);
      if (!existing) throw new AdeError("invalid_option", `Provider account "${id}" does not exist.`);
      const started = loginInfo(await callAccount("loginStart", { id, ...options }), id, existing.provider);
      const listeners = new Set<(status: SignInStatus) => void>();
      let current = started;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      let delay = 500;
      let resolveDone!: (account: AccountInfo) => void;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<AccountInfo>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      const publish = (status: SignInStatus) => {
        current = status;
        for (const listener of [...listeners]) {
          try { listener(status); } catch { /* Isolate embedder callbacks. */ }
        }
      };
      const finish = (status: SignInStatus, failure?: Error) => {
        if (finished) return;
        if (JSON.stringify(status) !== JSON.stringify(current)) publish(status);
        finished = true;
        if (timer) clearTimeout(timer);
        timer = null;
        handles.delete(handle);
        if (status.state === "succeeded") {
          void (async () => {
            try {
              await callAccount("refresh", { instanceId: id });
              const account = (await listAccounts(existing.provider)).find((entry) => entry.id === id);
              if (!account) throw new AdeError("protocol_error", `Signed-in account "${id}" was not returned by refresh.`);
              resolveDone(account);
            } catch (error) { rejectDone(error instanceof Error ? error : new Error(String(error))); }
          })();
        } else {
          rejectDone(failure ?? new AdeError(status.state === "cancelled" || status.state === "expired" ? "unsupported" : "rpc_error", status.message ?? `Sign-in ${status.state}.`));
        }
      };
      const handle: SignInHandle & { dispose(): void; cancelForDispose(): Promise<void> } = {
        on: (_event, listener) => {
          listeners.add(listener);
          listener(current);
          return () => listeners.delete(listener);
        },
        submitCode: async (code) => {
          if (finished) throw new AdeError("disposed", "This sign-in has already finished.");
          if (!code.trim()) throw new AdeError("invalid_option", "A sign-in code is required.");
          await callAccount("loginSubmitCode", { loginId: current.loginId, code });
        },
        cancel: async () => {
          if (finished) return;
          await callAccount("loginCancel", { loginId: current.loginId });
          const cancelled = { ...current, state: "cancelled" as const, endedAt: new Date().toISOString() };
          publish(cancelled);
          finish(cancelled);
        },
        done,
        cancelForDispose: async () => {
          if (finished) return;
          try { await callAccount("loginCancel", { loginId: current.loginId }); } catch { /* Runtime may already be closing. */ }
          const cancelled = { ...current, state: "cancelled" as const, endedAt: new Date().toISOString() };
          publish(cancelled);
          finish(cancelled);
        },
        dispose: () => {
          if (!finished) rejectDone(new AdeError("disposed", "The ADE chat client was disposed during sign-in."));
          if (timer) clearTimeout(timer);
          timer = null;
          finished = true;
          listeners.clear();
        },
      };
      const poll = async (): Promise<void> => {
        if (finished) return;
        try {
          assertUsable();
          const status = loginInfo(await callAccount("loginStatus", { loginId: current.loginId }), id, existing.provider);
          if (JSON.stringify(status) !== JSON.stringify(current)) publish(status);
          if (status.state === "succeeded" || status.state === "failed" || status.state === "cancelled" || status.state === "expired") {
            finish(status);
            return;
          }
          delay = Math.min(5_000, delay * 1.5);
        } catch (error) {
          if (finished) return;
          if (error instanceof AdeError && error.code === "disposed") {
            handle.dispose();
            rejectDone(error);
            return;
          }
          if (error instanceof AdeError && error.code === "unsupported") {
            finish({ ...current, state: "failed", message: error.message, endedAt: new Date().toISOString() }, error);
            return;
          }
          delay = Math.min(5_000, delay * 1.5);
        }
        timer = setTimeout(() => { void poll(); }, delay);
      };
      handles.add(handle);
      if (started.state === "succeeded" || started.state === "failed" || started.state === "cancelled" || started.state === "expired") finish(started);
      else timer = setTimeout(() => { void poll(); }, delay);
      return handle;
    },
  };

  const credentials: AccountManagement["credentials"] = {
    list: async (provider) => {
      assertUsable();
      const value = await call("credentials", "list", provider ? { provider } : {});
      return rows(value, "credentials").map(credentialInfo);
    },
    add: async ({ provider, key, label }) => {
      assertUsable();
      if (!key) throw new AdeError("invalid_option", "credentials.add() needs a key value.");
      return credentialInfo(await call("credentials", "store", { provider, key, label }));
    },
    remove: async (id, provider) => {
      assertUsable();
      return await call("credentials", "remove", { credentialId: id, ...(provider ? { provider } : {}) });
    },
    verify: async (provider) => {
      assertUsable();
      return withoutSecrets(await call("credentials", "verify", { provider }));
    },
  };

  const presets: AccountManagement["presets"] = {
    list: async () => {
      assertUsable();
      return rows(await call("presets", "list", {}), "presets").map((entry) => record(withoutSecrets(entry)));
    },
    add: async (input) => {
      assertUsable();
      return record(withoutSecrets(await call("presets", "create", input)));
    },
    update: async (id, patch) => {
      assertUsable();
      return record(withoutSecrets(await call("presets", "update", { id, ...patch })));
    },
    remove: async (id) => {
      assertUsable();
      return await call("presets", "remove", { id });
    },
  };

  return {
    accounts,
    credentials,
    presets,
    dispose: async () => {
      await Promise.all([...handles].map(async (handle) => {
        await handle.cancelForDispose();
        handle.dispose();
      }));
      handles.clear();
    },
  };
}
