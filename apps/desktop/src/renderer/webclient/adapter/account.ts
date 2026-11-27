import type {
  AdeAccountMachinesResult,
  AdeAccountStatus,
} from "../../../shared/types/account";
import {
  browserAccountIsSignedIn,
  type BrowserAccountClient,
  type BrowserAccountSnapshot,
  type BrowserAccountState,
} from "../account/client";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { ANNOUNCEMENTS_SEEN_SETTING_KEY } from "../../../shared/announcementsSeen";
import type { AdapterInfra } from "./types";
import type { AccountSettingRow } from "../../../shared/types/accountSettings";
import { relayBaseUrl } from "./attention";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
import { BRAND } from "../../../shared/brand";

function loginStatus(state: BrowserAccountState): "pending" | "signed_in" | "expired" {
  if (browserAccountIsSignedIn(state)) return "signed_in";
  if (state === "auth_expired") return "expired";
  return "pending";
}

export function browserAccountStatus(snapshot: BrowserAccountSnapshot): AdeAccountStatus {
  return {
    signedIn: browserAccountIsSignedIn(snapshot.state),
    userId: snapshot.userId,
    email: snapshot.email,
    name: snapshot.name,
    expiresAt: snapshot.expiresAt,
    provider: null,
    imageUrl: snapshot.imageUrl,
    configured: snapshot.state !== "unconfigured",
  };
}

function machinesResult(snapshot: BrowserAccountSnapshot): AdeAccountMachinesResult {
  switch (snapshot.state) {
    case "signed_in":
      return { state: "ok", machines: snapshot.machines, message: snapshot.message };
    case "signed_out":
      return { state: "signed_out", machines: [], message: snapshot.message };
    case "auth_expired":
      return { state: "auth_expired", machines: [], message: snapshot.message };
    case "unconfigured":
      return { state: "not_configured", machines: [], message: snapshot.message };
    case "loading":
    case "directory_unavailable":
      return { state: "unavailable", machines: [], message: snapshot.message };
  }
}

export function createAccountNamespace(
  accountClient: BrowserAccountClient,
): Window["ade"]["account"] {
  return {
    status: async () => browserAccountStatus(accountClient.getSnapshot()),
    startLogin: async () => {
      const authorizeUrl = await accountClient.startSignIn();
      return {
        sessionId: "browser-redirect",
        authorizeUrl,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    },
    pollLogin: async () => {
      const snapshot = accountClient.getSnapshot();
      return {
        status: loginStatus(snapshot.state),
        message: snapshot.message,
        authStatus: browserAccountStatus(snapshot),
      };
    },
    cancelLogin: async () => browserAccountStatus(accountClient.getSnapshot()),
    // The device flow exists so a machine's own brain can earn a pairing grant
    // and spend it locally. A hosted browser has no brain, so it has nothing to
    // re-pair; the affordance that uses this is hidden in web mode, and this
    // says why rather than starting a sign-in that could never help.
    startDeviceLogin: async () => {
      throw new Error(`Open ${BRAND.NAME} on the computer you want to reconnect, then try again there.`);
    },
    pollDeviceLogin: async () => ({
      status: "error" as const,
      message: `Open ${BRAND.NAME} on the computer you want to reconnect, then try again there.`,
      intervalSec: null,
      authStatus: browserAccountStatus(accountClient.getSnapshot()),
    }),
    cancelDeviceLogin: async () => browserAccountStatus(accountClient.getSnapshot()),
    signOut: async () => browserAccountStatus(await accountClient.signOut()),
    // This browser's own account session deletes the account, then signs out.
    deleteAccount: async () => browserAccountStatus(await accountClient.deleteAccount()),
    listMachines: async () => machinesResult(await accountClient.loadMachines()),
    renameMachine: async (machineKey: string, customName: string | null) =>
      await accountClient.renameMachine(machineKey, customName),
    // A hosted browser is a controller, not an account-directory machine.
    getLocalMachineIdentity: async () => ({ machineKey: "", deviceId: "" }),
    pairMachine: async () => {
      throw new Error("Choose this machine from the web machine switcher.");
    },
    onPairMachineProgress: () => () => {},
    removeMachine: async (machineKey: string) => await accountClient.removeMachine(machineKey),
    // Reconnecting re-registers the machine the ADE brain runs on. A hosted
    // browser has no brain of its own, so it cannot repair anything; the action
    // is hidden in web mode rather than left to fail here.
    repairMachinePairing: async () => {
      throw new Error(`Open ${BRAND.NAME} on the computer you want to reconnect, then try again there.`);
    },
  };
}

/** A failed account settings call: the caller keeps its local copy. Method and status only, never a key or a value. */
function reportRelayFailure(method: string, status: number, error?: unknown): void {
  console.warn("[cloud] account settings call failed", method, status, error instanceof Error ? error.message : "");
  forwardSignalToSentry("web.account_settings_relay_failed", { method, status }, `account_settings_relay_failed:${method}`, "info");
}

/** Pages one settings read follows at most (the relay serves 1,000 rows a page). */
const SETTINGS_MAX_PAGES = 5;
/** This browser's writer id in the account settings rows. */
const WEB_SETTINGS_DEVICE_ID = "ade-web";

type RelaySettingsPage = { ok?: boolean; settings?: unknown; truncated?: boolean; cursor?: string | null };

function settingRowOf(value: unknown): AccountSettingRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.scope !== "string" || typeof row.key !== "string" || typeof row.updatedAt !== "string") return null;
  if (row.deleted === true) return null;
  return {
    scope: row.scope,
    key: row.key,
    value: row.value,
    updatedAt: row.updatedAt,
    changedAt: typeof row.changedAt === "string" ? row.changedAt : null,
    writerDeviceId: typeof row.writerDeviceId === "string" ? row.writerDeviceId : null,
  };
}

/**
 * The account settings store on the web: the push relay's
 * `/attention/account/settings` route with this browser's account token.
 * Account settings hold no secret (secrets live in the vault, which the
 * relay refuses to a browser), so the relay lets the web read and write them.
 *
 * - A signed-out browser, or a relay that fails, answers `unavailable`, the
 *   answer every caller already handles by keeping its local copy.
 * - The "What's new" seen pages (`announcementSeenSync.ts`) stay on the
 *   connected computer's brain while one is connected: its write is a union,
 *   never a replace. With no computer, they go to the relay like the rest.
 */
export function createAccountSettingsNamespace(
  infra?: Pick<AdapterInfra, "commands" | "events">,
  accountClient?: BrowserAccountClient,
): NonNullable<Window["ade"]["accountSettings"]> {
  const unavailable = {
    ok: false as const,
    unavailable: true as const,
    message: `Your ${BRAND.NAME} account settings didn't load. Try again.`,
  };
  const isSeenKey = (args: { scope: string; key: string }) =>
    args.scope === ACCOUNT_SCOPE_ALL && args.key === ANNOUNCEMENTS_SEEN_SETTING_KEY;
  const brainServesSeen = () => Boolean(infra?.commands.hasAction("announcements.getSeen"));
  const changed = new Set<() => void>();

  /** One relay call with the account token; null when signed out or it failed. */
  const relay = async (method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Record<string, unknown> | null> => {
    if (!accountClient) return null;
    const lease = accountClient.captureSessionLease();
    if (!lease) return null;
    const once = async (forceRefresh: boolean) => {
      const token = await accountClient.getAccessToken({ forceRefresh });
      if (!accountClient.isSessionLeaseCurrent(lease)) return null;
      return await fetch(`${relayBaseUrl()}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    };
    try {
      let response = await once(false);
      if (response?.status === 401) response = await once(true);
      // No response: the session changed during the call, which is not a failure.
      if (!response) return null;
      if (!response.ok) {
        reportRelayFailure(method, response.status);
        return null;
      }
      const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!parsed || parsed.ok === false) {
        reportRelayFailure(method, response.status);
        return null;
      }
      return parsed;
    } catch (error) {
      reportRelayFailure(method, 0, error);
      return null;
    }
  };

  const listRows = async (scope: string | null | undefined): Promise<AccountSettingRow[] | null> => {
    const rows: AccountSettingRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SETTINGS_MAX_PAGES; page += 1) {
      const query = new URLSearchParams();
      if (scope) query.set("scope", scope);
      if (cursor) query.set("since", cursor);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      const answer = await relay("GET", `/attention/account/settings${suffix}`) as RelaySettingsPage | null;
      if (!answer || !Array.isArray(answer.settings)) return null;
      for (const value of answer.settings) {
        const row = settingRowOf(value);
        if (row) rows.push(row);
      }
      if (!answer.truncated || !answer.cursor || answer.cursor === cursor) break;
      cursor = answer.cursor;
    }
    return rows;
  };

  const notify = () => {
    for (const listener of changed) {
      try {
        listener();
      } catch {
        // One listener's failure is its own.
      }
    }
  };

  return {
    list: async (args) => {
      const rows = await listRows(args?.scope ?? null);
      return rows ? { ok: true as const, value: rows } : unavailable;
    },
    get: async (args) => {
      if (infra && isSeenKey(args) && brainServesSeen()) {
        try {
          const result = await infra.commands.call<{ available?: boolean; value?: unknown }>(
            "announcements.getSeen",
            {},
            { fallback: { available: false }, requireProject: false, authoritative: true, cacheTtlMs: 0 },
          );
          return result?.available ? { ok: true as const, value: result.value } : unavailable;
        } catch {
          return unavailable;
        }
      }
      const rows = await listRows(args.scope);
      if (!rows) return unavailable;
      return { ok: true as const, value: rows.find((row) => row.key === args.key)?.value ?? null };
    },
    set: async (args) => {
      if (infra && isSeenKey(args) && brainServesSeen()) {
        try {
          const result = await infra.commands.call<{ ok?: boolean }>(
            "announcements.markSeen",
            { seen: args.value },
            { idempotent: false, requireProject: false, authoritative: true },
          );
          return result?.ok ? { ok: true as const, value: null } : unavailable;
        } catch {
          return unavailable;
        }
      }
      const answer = await relay("PUT", "/attention/account/settings", {
        deviceId: WEB_SETTINGS_DEVICE_ID,
        sentAt: new Date().toISOString(),
        settings: [{ scope: args.scope, key: args.key, value: args.value, changedAt: new Date().toISOString() }],
      });
      if (!answer) return unavailable;
      notify();
      return { ok: true as const, value: null };
    },
    remove: async (args) => {
      const answer = await relay(
        "DELETE",
        `/attention/account/settings/${encodeURIComponent(args.scope)}/${encodeURIComponent(args.key)}`,
      );
      if (!answer) return unavailable;
      notify();
      return { ok: true as const, value: null };
    },
    // The relay is the store: there is nothing to push or pull.
    sync: async () => (accountClient?.captureSessionLease() ? { ok: true as const, value: null } : unavailable),
    // A computer can connect after the first read failed: opening a project
    // on it is the moment to read again. A write from this page reads again too.
    onChanged: (cb) => {
      changed.add(cb);
      const offProject = infra?.events.on("projectChanged", () => cb()) ?? (() => {});
      return () => {
        changed.delete(cb);
        offProject();
      };
    },
  };
}
