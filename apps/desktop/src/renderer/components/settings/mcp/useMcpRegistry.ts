/**
 * Reading and writing the MCP registry from the settings page.
 *
 * The registry is three rows in the account settings store (see
 * `shared/mcpRegistry.ts`). They are read and written through
 * `window.ade.accountSettings`, the same bridge every account-scoped setting
 * uses; `window.ade.mcpRegistry` adds what only the main process can do: say
 * where this computer and this project file their rows, check this computer,
 * scan the provider CLIs' own configs, and write secret values to the vault.
 *
 * Every write goes to the brain's own copy and is awaited, because the brain
 * reads that same copy when it launches the next chat. A write that the brain
 * did not take comes back as a sentence, never as a thrown error, and the list
 * on screen is only changed after the brain confirmed it.
 *
 * Nothing here polls. The page loads once when it opens, again after each
 * change, and when asked.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ACCOUNT_SCOPE_ALL } from "../../../../shared/accountSettingsScope";
import {
  MCP_OFF_SETTING_KEY,
  MCP_REGISTRY_LIMITS,
  MCP_SERVERS_SETTING_KEY,
  mcpSecretVaultKey,
  normalizeMcpOffList,
  normalizeMcpRegistry,
  normalizeMcpRegistryServer,
  type McpRegistryServer,
  type McpSecretField,
} from "../../../../shared/mcpRegistry";
import type { McpFoundServer, McpRegistryContext, McpServerSignIn } from "../../../../shared/types/mcpRegistry";
import { useAppStore } from "../../../state/appStore";
import { isAdeAvailable } from "../../../lib/adeAvailability";

/** The three places a server can be switched off. */
export type McpRegistryLevel = "account" | "machine" | "project";

export type McpSecretValue = { field: McpSecretField; name: string; value: string };

export type McpRegistryView = {
  /**
   * `unavailable`: the background service could not be asked. The list is then
   * this computer's last saved copy, and nothing can be changed.
   */
  phase: "loading" | "ready" | "unavailable";
  /** Why, when `unavailable`. */
  message: string | null;
  servers: McpRegistryServer[];
  off: { machine: string[]; project: string[] };
  context: McpRegistryContext;
  /**
   * What this computer holds and can start. Null when it could not be checked;
   * the page then shows no warning rather than a wrong one.
   */
  check: {
    heldSecretKeys: ReadonlySet<string>;
    missingCommands: ReadonlySet<string>;
    /** Browser sign-in by server name, for servers that have or want one. */
    signIns: ReadonlyMap<string, McpServerSignIn>;
  } | null;
  /** Servers in the provider CLIs' own configs here that the registry does not have. */
  found: McpFoundServer[];
  /** Names the scan saw but ADE cannot hold. */
  skipped: string[];
};

export type McpRegistryApi = McpRegistryView & {
  reload: () => Promise<void>;
  /** Each resolves to null on success, or one sentence saying what went wrong. */
  saveServer: (server: McpRegistryServer, secrets: readonly McpSecretValue[], mode: "create" | "edit") => Promise<string | null>;
  removeServer: (name: string) => Promise<string | null>;
  setLevel: (name: string, level: McpRegistryLevel, on: boolean) => Promise<string | null>;
  setSecret: (server: string, field: McpSecretField, name: string, value: string) => Promise<string | null>;
  importFound: (name: string) => Promise<string | null>;
  /** Opens the browser and waits for it. `cancelled` covers Cancel here, a newer sign-in, or another window. */
  signIn: (server: McpRegistryServer) => Promise<{ ok: true } | { ok: false; cancelled: boolean; message: string }>;
  cancelSignIn: (name: string) => void;
  signOut: (name: string) => Promise<string | null>;
};

const NO_BRIDGE = "MCP servers can't be changed from here.";

const EMPTY: McpRegistryView = {
  phase: "loading",
  message: null,
  servers: [],
  off: { machine: [], project: [] },
  context: { deviceOffKey: null, repoScope: null, cached: null },
  check: null,
  found: [],
  skipped: [],
};

function errorSentence(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Something went wrong.");
}

export function useMcpRegistry(): McpRegistryApi {
  // A project tab bound to another computer has no checkout here to read a
  // remote from, so "this project" has nothing to file a row under.
  const projectRoot = useAppStore((state) =>
    state.projectBinding?.kind === "remote" ? null : state.project?.rootPath?.trim() || null);
  const [view, setView] = useState<McpRegistryView>(EMPTY);
  // The newest load wins: a slow answer for a project the user has left must
  // not overwrite the page for the project they are on.
  const loadSeq = useRef(0);

  const readAll = useCallback(async (): Promise<McpRegistryView> => {
    const settings = window.ade?.accountSettings;
    const registry = window.ade?.mcpRegistry;
    if (!isAdeAvailable(settings) || !isAdeAvailable(registry)) {
      return { ...EMPTY, phase: "unavailable", message: NO_BRIDGE };
    }
    // The scan and the context read files on this computer and need no brain,
    // so the "found here" list still shows when the registry itself cannot.
    const [context, scan] = await Promise.all([
      registry.context({ projectRoot }),
      registry.scan({ projectRoot }),
    ]);
    const [serversRow, machineRow, projectRow] = await Promise.all([
      settings.get({ scope: ACCOUNT_SCOPE_ALL, key: MCP_SERVERS_SETTING_KEY }),
      context.deviceOffKey ? settings.get({ scope: ACCOUNT_SCOPE_ALL, key: context.deviceOffKey }) : null,
      context.repoScope ? settings.get({ scope: context.repoScope, key: MCP_OFF_SETTING_KEY }) : null,
    ]);
    if (!serversRow.ok) {
      // Show this computer's own copy, the one a chat launch reads, so the
      // page still says what agents get. It cannot be changed until the
      // background service answers.
      const cached = context.cached;
      const cachedNames = new Set((cached?.servers ?? []).map((server) => server.name));
      return {
        ...EMPTY,
        phase: "unavailable",
        message: serversRow.message,
        context,
        servers: cached?.servers ?? [],
        off: cached?.off ?? EMPTY.off,
        found: scan.servers.filter((server) => !cachedNames.has(server.name)),
        skipped: scan.skipped,
      };
    }
    const servers = normalizeMcpRegistry(serversRow.value);
    const check = await registry.check({ servers });
    const known = new Set(servers.map((server) => server.name));
    return {
      phase: "ready",
      message: null,
      servers,
      off: {
        machine: machineRow?.ok ? normalizeMcpOffList(machineRow.value) : [],
        project: projectRow?.ok ? normalizeMcpOffList(projectRow.value) : [],
      },
      context,
      check: check.ok
        ? {
            heldSecretKeys: new Set(check.value.heldSecretKeys),
            missingCommands: new Set(check.value.missingCommands),
            signIns: new Map((check.value.signIns ?? []).map((entry) => [entry.server, entry])),
          }
        : null,
      found: scan.servers.filter((server) => !known.has(server.name)),
      skipped: scan.skipped,
    };
  }, [projectRoot]);

  const reload = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    let next: McpRegistryView;
    try {
      next = await readAll();
    } catch (error) {
      next = { ...EMPTY, phase: "unavailable", message: errorSentence(error) };
    }
    if (seq === loadSeq.current) setView(next);
  }, [readAll]);

  useEffect(() => {
    void reload();
    // One pull when the page opens, so a server added on another computer is
    // here without waiting for the background tick. Best-effort: offline, the
    // page already shows this computer's copy.
    void window.ade?.accountSettings?.sync().then((result) => {
      if (result.ok) void reload();
    }).catch(() => undefined);
    return () => {
      loadSeq.current += 1;
    };
  }, [reload]);

  /**
   * One change to the list, applied to the brain's copy as it is NOW rather
   * than as this page last read it, so two computers editing different servers
   * do not undo each other. `change` returns the new list, or a sentence.
   */
  const writeServers = useCallback(async (
    change: (current: McpRegistryServer[]) => McpRegistryServer[] | string,
  ): Promise<string | null> => {
    const settings = window.ade?.accountSettings;
    if (!settings) return NO_BRIDGE;
    const row = await settings.get({ scope: ACCOUNT_SCOPE_ALL, key: MCP_SERVERS_SETTING_KEY });
    if (!row.ok) return row.message;
    const next = change(normalizeMcpRegistry(row.value));
    if (typeof next === "string") return next;
    const written = await settings.set({ scope: ACCOUNT_SCOPE_ALL, key: MCP_SERVERS_SETTING_KEY, value: next });
    return written.ok ? null : written.message;
  }, []);

  /** Adds a name to, or takes it out of, one "switched off here" list. */
  const writeOff = useCallback(async (
    target: { scope: string; key: string },
    name: string,
    off: boolean,
  ): Promise<string | null> => {
    const settings = window.ade?.accountSettings;
    if (!settings) return NO_BRIDGE;
    const row = await settings.get(target);
    if (!row.ok) return row.message;
    const current = normalizeMcpOffList(row.value);
    if (current.includes(name) === off) return null;
    const next = off ? [...current, name] : current.filter((entry) => entry !== name);
    const written = await settings.set({ ...target, value: next });
    return written.ok ? null : written.message;
  }, []);

  /** Runs one change, then shows what the brain holds now, whatever the outcome. */
  const mutate = useCallback(async (run: () => Promise<string | null>): Promise<string | null> => {
    let outcome: string | null;
    try {
      outcome = await run();
    } catch (error) {
      outcome = errorSentence(error);
    }
    await reload();
    return outcome;
  }, [reload]);

  const offTarget = useCallback((level: "machine" | "project"): { scope: string; key: string } | null => {
    if (level === "machine") {
      return view.context.deviceOffKey ? { scope: ACCOUNT_SCOPE_ALL, key: view.context.deviceOffKey } : null;
    }
    return view.context.repoScope ? { scope: view.context.repoScope, key: MCP_OFF_SETTING_KEY } : null;
  }, [view.context]);

  const saveServer = useCallback((
    draft: McpRegistryServer,
    secrets: readonly McpSecretValue[],
    mode: "create" | "edit",
  ) => mutate(async () => {
    const registry = window.ade?.mcpRegistry;
    if (!isAdeAvailable(registry)) return NO_BRIDGE;
    const server = normalizeMcpRegistryServer(draft);
    if (!server) return "ADE can't save that server. Check its name and its command or URL.";
    // A new name is checked against the brain's own list before anything is
    // written: this page's list can be behind another computer's, and the
    // values below would otherwise overwrite that server's.
    if (mode === "create") {
      const settings = window.ade?.accountSettings;
      if (!settings) return NO_BRIDGE;
      const row = await settings.get({ scope: ACCOUNT_SCOPE_ALL, key: MCP_SERVERS_SETTING_KEY });
      if (!row.ok) return row.message;
      if (normalizeMcpRegistry(row.value).some((entry) => entry.name === server.name)) {
        return `You already have a server named ${server.name}.`;
      }
    }
    // Values first: once the server is in the list the next chat starts it,
    // and it must find its values already there.
    for (const secret of secrets) {
      if (!secret.value.length) continue;
      const stored = await registry.setSecret({ server: server.name, field: secret.field, name: secret.name, value: secret.value });
      if (!stored.ok) return stored.message;
    }
    const written = await writeServers((current) => {
      const index = current.findIndex((entry) => entry.name === server.name);
      if (mode === "create") {
        if (index >= 0) return `You already have a server named ${server.name}.`;
        if (current.length >= MCP_REGISTRY_LIMITS.maxServers) return `You can have up to ${MCP_REGISTRY_LIMITS.maxServers} servers.`;
        return [...current, server];
      }
      if (index < 0) return `${server.name} was removed on another computer.`;
      return current.map((entry, at) => (at === index ? server : entry));
    });
    if (written) return written;
    // Values the server no longer names. A failure here leaves an unused
    // value in the vault, not a broken server, so it does not fail the save.
    await registry.pruneSecrets({ server: server.name, keep: server });
    return null;
  }), [mutate, writeServers]);

  const removeServer = useCallback((name: string) => mutate(async () => {
    const registry = window.ade?.mcpRegistry;
    if (!isAdeAvailable(registry)) return NO_BRIDGE;
    const written = await writeServers((current) => current.filter((entry) => entry.name !== name));
    if (written) return written;
    // A later server of the same name must not start out switched off here.
    for (const level of ["machine", "project"] as const) {
      const target = offTarget(level);
      if (target) await writeOff(target, name, false);
    }
    const pruned = await registry.pruneSecrets({ server: name, keep: null });
    return pruned.ok ? null : `${name} was removed, but its saved values were not: ${pruned.message}`;
  }), [mutate, offTarget, writeOff, writeServers]);

  const setLevel = useCallback((name: string, level: McpRegistryLevel, on: boolean) => mutate(async () => {
    if (level === "account") {
      return await writeServers((current) => current.map((entry) => (entry.name === name ? { ...entry, enabled: on } : entry)));
    }
    const target = offTarget(level);
    if (!target) {
      return level === "machine"
        ? "This computer has no sync identity yet. Sign in to ADE on it first."
        : "This project has no git remote, so ADE can't tell it apart on your other computers.";
    }
    return await writeOff(target, name, !on);
  }), [mutate, offTarget, writeOff, writeServers]);

  const setSecret = useCallback((server: string, field: McpSecretField, name: string, value: string) => mutate(async () => {
    const registry = window.ade?.mcpRegistry;
    if (!isAdeAvailable(registry)) return NO_BRIDGE;
    const stored = await registry.setSecret({ server, field, name, value });
    return stored.ok ? null : stored.message;
  }), [mutate]);

  const importFound = useCallback((name: string) => mutate(async () => {
    const registry = window.ade?.mcpRegistry;
    if (!isAdeAvailable(registry)) return NO_BRIDGE;
    // The import replaces the vault values under this name. Read the list as
    // it is now, not as the page loaded it: another computer may have added a
    // server with this name, and its values must stay.
    const settings = window.ade?.accountSettings;
    if (!settings) return NO_BRIDGE;
    const row = await settings.get({ scope: ACCOUNT_SCOPE_ALL, key: MCP_SERVERS_SETTING_KEY });
    if (!row.ok) return row.message;
    if (normalizeMcpRegistry(row.value).some((entry) => entry.name === name)) return `You already have a server named ${name}.`;
    const imported = await registry.import({ name, projectRoot });
    if (!imported.ok) return imported.message;
    return await writeServers((current) => {
      if (current.some((entry) => entry.name === imported.value.name)) return `You already have a server named ${imported.value.name}.`;
      if (current.length >= MCP_REGISTRY_LIMITS.maxServers) return `You can have up to ${MCP_REGISTRY_LIMITS.maxServers} servers.`;
      return [...current, imported.value];
    });
  }), [mutate, projectRoot, writeServers]);

  const signIn = useCallback(async (server: McpRegistryServer) => {
    let cancelled = false;
    const message = await mutate(async () => {
      const registry = window.ade?.mcpRegistry;
      if (!isAdeAvailable(registry)) return NO_BRIDGE;
      const result = await registry.signIn({ server });
      if (result.ok) return null;
      cancelled = "cancelled" in result && result.cancelled === true;
      return result.message;
    });
    return message == null ? { ok: true as const } : { ok: false as const, cancelled, message };
  }, [mutate]);

  const cancelSignIn = useCallback((name: string) => {
    if (isAdeAvailable(window.ade?.mcpRegistry?.cancelSignIn)) void window.ade.mcpRegistry.cancelSignIn({ server: name });
  }, []);

  const signOut = useCallback((name: string) => mutate(async () => {
    const registry = window.ade?.mcpRegistry;
    if (!isAdeAvailable(registry)) return NO_BRIDGE;
    const result = await registry.signOut({ server: name });
    return result.ok ? null : result.message;
  }), [mutate]);

  return { ...view, reload, saveServer, removeServer, setLevel, setSecret, importFound, signIn, cancelSignIn, signOut };
}

/** The secret values of one server this computer does not hold, as `field` + `name`. */
export function missingMcpSecrets(
  server: McpRegistryServer,
  heldSecretKeys: ReadonlySet<string>,
): Array<{ field: McpSecretField; name: string }> {
  return [
    ...server.envNames.map((name) => ({ field: "env" as const, name })),
    ...server.headerNames.map((name) => ({ field: "header" as const, name })),
  ].filter((entry) => !heldSecretKeys.has(mcpSecretVaultKey(server.name, entry.field, entry.name)));
}
