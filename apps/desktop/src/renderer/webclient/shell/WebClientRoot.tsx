import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "../../../shared/types";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type { DeeplinkTarget } from "../../../shared/deeplinks";
import type {
  AdeSyncClient,
  AdeSyncClientStatus,
  WebRelayAccess,
  WebClientEnvironmentRecord,
} from "../sync";
import { WebRelayAuthRequiredError } from "../sync";
import {
  BrowserAccountClient,
  type BrowserAccountSnapshot,
} from "../account/client";
import {
  accountLeaseOwnerForActiveConnection,
  reconcileActiveAccountLease,
} from "../account/leaseMonitor";
import { parseOpenTarget, parseWebPath, targetToWebPath } from "./webRoutes";
import { ScreenShell } from "./ScreenShell";
import { PairFlow } from "./PairFlow";
import { ProjectPicker } from "./ProjectPicker";
import { WebShell } from "./WebShell";
import { MachinePicker } from "./MachinePicker";
import { COLORS, SANS_FONT, primaryButton } from "./shellTokens";

type AdeWebAdapter = {
  ade: Window["ade"];
  bindProject: (project: ProjectInfo | null) => void;
  dispose: () => void;
};

async function loadAdapter(client: AdeSyncClient, initialCatalog?: SyncMobileProjectSummary[]): Promise<AdeWebAdapter> {
  const module = await import("../adapter/index");
  return module.createAdeWebAdapter(client, initialCatalog);
}

async function loadAppRoot(): Promise<React.ComponentType> {
  const [{ App }, { RendererErrorBoundary }, { useAppStore }] = await Promise.all([
    import("../../components/app/App"),
    import("../../components/app/RendererErrorBoundary"),
    import("../../state/appStore"),
  ]);
  try {
    useAppStore.getState().applyAutoSizeChatFontOnLargeScreenIfNotOverridden();
  } catch {
    // Non-fatal — fall back to the persisted/default chat font size.
  }
  return function MountedApp() {
    return (
      <RendererErrorBoundary>
        <App />
      </RendererErrorBoundary>
    );
  };
}

const PENDING_TARGET_KEY = "ade-web:pending-target";
const ACCOUNT_LEASE_CHECK_INTERVAL_MS = 30_000;
const APP_ROUTE_ROOTS = [
  "/work", "/lanes", "/files", "/prs", "/review", "/history",
  "/automations", "/cto", "/settings", "/graph", "/project", "/chats",
];

function isAppRoute(pathname: string): boolean {
  return APP_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

function isChatsRoute(pathname: string): boolean {
  return pathname === "/chats" || pathname.startsWith("/chats/");
}

function toProjectInfo(project: SyncMobileProjectSummary): ProjectInfo {
  return {
    rootPath: project.rootPath ?? `remote:${project.id}`,
    displayName: project.displayName,
    baseRef: project.defaultBaseRef ?? "main",
  };
}

function stashTarget(target: DeeplinkTarget | null): void {
  try {
    if (target) sessionStorage.setItem(PENDING_TARGET_KEY, JSON.stringify(target));
    else sessionStorage.removeItem(PENDING_TARGET_KEY);
  } catch {
    // sessionStorage may be unavailable (private mode); in-memory ref covers it.
  }
}

function readStashedTarget(): DeeplinkTarget | null {
  try {
    const raw = sessionStorage.getItem(PENDING_TARGET_KEY);
    return raw ? (JSON.parse(raw) as DeeplinkTarget) : null;
  } catch {
    return null;
  }
}

type Phase =
  | { kind: "loading" }
  | { kind: "machine-picker" }
  | { kind: "pairing"; reloadOnSuccess: boolean }
  | { kind: "connecting"; name: string }
  | { kind: "auth-required"; message: string }
  | { kind: "project-picker"; projects: SyncMobileProjectSummary[] }
  | { kind: "ready"; AppRoot: React.ComponentType }
  | { kind: "error"; message: string; canRetry: boolean };

function relayAccessFromAccount(
  account: BrowserAccountSnapshot,
  getAccessToken: () => Promise<string>,
): WebRelayAccess {
  if (
    (account.state === "signed_in" || account.state === "directory_unavailable")
    && account.userId
  ) {
    return {
      kind: "signed_in",
      userId: account.userId,
      hostDeviceIds: account.machines.flatMap((machine) => machine.deviceId ? [machine.deviceId] : []),
      getAccessToken,
    };
  }
  return { kind: "signed_out" };
}

export function WebClientRoot({
  client,
  accountClient: providedAccountClient,
}: {
  client: AdeSyncClient;
  accountClient?: BrowserAccountClient;
}) {
  const [accountClient] = useState(() => providedAccountClient ?? new BrowserAccountClient());
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [status, setStatus] = useState<AdeSyncClientStatus>(() => client.getStatus());
  const [environments, setEnvironments] = useState<WebClientEnvironmentRecord[]>([]);
  const [catalog, setCatalog] = useState<SyncMobileProjectSummary[]>([]);
  const [account, setAccount] = useState<BrowserAccountSnapshot>(() => accountClient.getSnapshot());
  const [connectingAccountMachineKey, setConnectingAccountMachineKey] = useState<string | null>(null);

  const adapterRef = useRef<AdeWebAdapter | null>(null);
  const stashedTargetRef = useRef<DeeplinkTarget | null>(null);
  const bootedRef = useRef(false);
  const fatalRebootRef = useRef(false);
  const phaseIsReadyRef = useRef(false);
  const connectingAccountMachineRef = useRef<string | null>(null);
  phaseIsReadyRef.current = phase.kind === "ready";
  const relayAccess = useMemo(
    () => relayAccessFromAccount(account, () => accountClient.getAccessToken()),
    [account, accountClient],
  );

  const refreshEnvironments = useCallback(async () => {
    const list = await client.listEnvironments();
    setEnvironments(list);
    return list;
  }, [client]);

  const applyAccountPrivacy = useCallback(async (
    snapshot: BrowserAccountSnapshot,
  ): Promise<WebClientEnvironmentRecord[]> => {
    const currentOwnerUserId = (
      snapshot.state === "signed_in" || snapshot.state === "directory_unavailable"
    )
      ? snapshot.userId
      : null;
    await client.pruneAccountOwnedEnvironments(currentOwnerUserId);
    setAccount(snapshot);
    return await refreshEnvironments();
  }, [client, refreshEnvironments]);

  const showPairing = useCallback((reloadOnSuccess: boolean) => {
    fatalRebootRef.current = false;
    setPhase({ kind: "pairing", reloadOnSuccess });
  }, []);

  const showMachinePicker = useCallback(() => {
    fatalRebootRef.current = false;
    setPhase({ kind: "machine-picker" });
  }, []);

  // Bring the connected machine's catalog + selected project online, then mount
  // the shared App with the sync-backed adapter installed on window.ade.
  const enterProject = useCallback(async (project: SyncMobileProjectSummary, catalogSeed?: SyncMobileProjectSummary[]) => {
    // Switch onto the target project's host only when it isn't already the
    // active one. The host serves file_request/commands for the peer's bound
    // project without a redundant switch, so avoid the extra disconnect +
    // reconnect (and its startup latency) when we're already on this project.
    if (project.id !== client.getStatus().activeProjectId) {
      await client.switchProject(project.id).catch(() => {});
    }
    if (!adapterRef.current) {
      adapterRef.current = await loadAdapter(client, catalogSeed);
    }
    window.ade = adapterRef.current.ade;
    adapterRef.current.bindProject(toProjectInfo(project));

    // Point the address bar at the initial App route before mounting so the
    // App's BrowserRouter renders the right tab on first paint.
    const stashed = stashedTargetRef.current;
    const initialPath = stashed
      ? targetToWebPath(stashed)
      : (isAppRoute(window.location.pathname) ? `${window.location.pathname}${window.location.search}` : "/work");
    window.history.replaceState(null, "", initialPath);
    stashedTargetRef.current = null;
    stashTarget(null);

    const AppRoot = await loadAppRoot();
    setPhase({ kind: "ready", AppRoot });
  }, [client]);

  const enterChats = useCallback(async (
    catalogSeed?: SyncMobileProjectSummary[],
    initialPath = "/chats",
  ) => {
    if (!adapterRef.current) {
      adapterRef.current = await loadAdapter(client, catalogSeed);
    }
    window.ade = adapterRef.current.ade;
    adapterRef.current.bindProject(null);
    stashedTargetRef.current = null;
    stashTarget(null);
    window.history.replaceState(null, "", initialPath);
    const AppRoot = await loadAppRoot();
    setPhase({ kind: "ready", AppRoot });
  }, [client]);

  const afterConnect = useCallback(async () => {
    const activeEnv = (await client.listEnvironments()).find((environment) => environment.envId === client.getStatus().selectedEnvId) ?? null;
    let projects: SyncMobileProjectSummary[] = [];
    try {
      projects = (await client.getProjectCatalog()).projects;
    } catch {
      projects = [];
    }
    setCatalog(projects);

    if (isChatsRoute(window.location.pathname)) {
      await enterChats(projects, `${window.location.pathname}${window.location.search}`);
      return;
    }

    const activeProjectId = client.getStatus().activeProjectId;
    const chosen =
      projects.find((project) => project.id === activeEnv?.activeProjectId && (project.isAvailable || project.isOpen))
      ?? projects.find((project) => project.id === activeProjectId)
      ?? projects.find((project) => project.isOpen)
      ?? (projects.length === 1 ? projects[0] : null);

    if (chosen) {
      await enterProject(chosen, projects);
    } else {
      setPhase({ kind: "project-picker", projects });
    }
  }, [client, enterChats, enterProject]);

  const connectTo = useCallback(async (environment: WebClientEnvironmentRecord) => {
    setPhase({ kind: "connecting", name: environment.machineName });
    try {
      await client.connect(environment.envId, relayAccess);
      await afterConnect();
    } catch (error) {
      if (error instanceof WebRelayAuthRequiredError) {
        setPhase({ kind: "auth-required", message: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setPhase({ kind: "error", message, canRetry: true });
    }
  }, [client, relayAccess, afterConnect]);

  const connectToAccountMachine = useCallback(async (machine: AdeAccountMachine) => {
    if (connectingAccountMachineRef.current) return;
    connectingAccountMachineRef.current = machine.machineKey;
    setConnectingAccountMachineKey(machine.machineKey);
    try {
      const accessToken = await accountClient.getAccessToken();
      const accountSessionLease = accountClient.captureSessionLease();
      if (!accountSessionLease) {
        throw new Error("Sign in again to connect this machine.");
      }
      await client.pairWithAccountMachine({
        machine,
        accessToken,
        accountSessionLease,
        isAccountSessionLeaseCurrent: (lease) => accountClient.isSessionLeaseCurrent(lease),
        deviceName: `ADE Web on ${window.location.hostname || "browser"}`,
        relayBaseUrls: accountClient.getRelayBaseUrls(),
        getRelayAccountToken: () => accountClient.getAccessToken(),
      });
      await refreshEnvironments();
      await afterConnect();
    } catch (error) {
      const snapshot = accountClient.getSnapshot();
      await applyAccountPrivacy(snapshot);
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        canRetry: true,
      });
    } finally {
      connectingAccountMachineRef.current = null;
      setConnectingAccountMachineKey(null);
    }
  }, [accountClient, afterConnect, applyAccountPrivacy, client, refreshEnvironments]);

  // ---- Boot sequence ------------------------------------------------------
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void (async () => {
      const path = window.location.pathname;
      if (path === "/open") {
        stashedTargetRef.current = parseOpenTarget(window.location.search);
        stashTarget(stashedTargetRef.current);
      } else if (isAppRoute(path)) {
        stashedTargetRef.current = parseWebPath(`${path}${window.location.search}`);
      } else {
        stashedTargetRef.current = readStashedTarget();
      }

      if (path === "/account/callback") {
        setAccount((current) => ({ ...current, state: "loading", message: null }));
      }
      const accountSnapshot = await accountClient.bootstrap();
      await applyAccountPrivacy(accountSnapshot);
      if (path === "/pair") {
        setPhase({ kind: "pairing", reloadOnSuccess: false });
        return;
      }
      setPhase({ kind: "machine-picker" });
    })().catch((error) => {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error), canRetry: false });
    });
  }, [accountClient, applyAccountPrivacy]);

  // ---- Live status subscription ------------------------------------------
  useEffect(() => {
    return client.subscribe((next) => {
      setStatus(next);
      // Pairing revoked or invalid after capped auth failures. Drop the selected
      // environment locally so a reboot/retry cannot loop on the stale secret.
      if (next.state === "auth_failed" && !fatalRebootRef.current) {
        fatalRebootRef.current = true;
        void (async () => {
          if (next.selectedEnvId) await client.removeEnvironment(next.selectedEnvId).catch(() => undefined);
          await refreshEnvironments().catch(() => undefined);
          if (phaseIsReadyRef.current) {
            window.location.assign("/");
          } else {
            setPhase({ kind: "machine-picker" });
          }
        })();
      }
    });
  }, [client, refreshEnvironments]);

  useEffect(() => {
    return client.onProjectCatalog((payload) => setCatalog(payload.projects));
  }, [client]);

  // Account-owned trust and account-authorized Relay sockets stay usable only
  // while the same browser account remains valid. A local pairing keeps its
  // saved trust after Relay logout so it can reconnect directly later.
  useEffect(() => {
    if (
      status.state !== "connecting"
      && status.state !== "connected"
      && status.state !== "reconnecting"
    ) {
      return;
    }
    const activeEnvironment = environments.find(
      (environment) => environment.envId === status.selectedEnvId,
    );
    if (!activeEnvironment) return;
    const expectedOwnerUserId = accountLeaseOwnerForActiveConnection({
      environment: activeEnvironment,
      endpoint: status.endpoint,
      relayAccess,
    });
    if (!expectedOwnerUserId) return;

    let disposed = false;
    let checkInFlight = false;
    const checkLease = async () => {
      if (disposed || checkInFlight) return;
      checkInFlight = true;
      try {
        const result = await reconcileActiveAccountLease({
          accountClient,
          syncClient: client,
          expectedOwnerUserId,
        });
        if (result.state !== "revoked") return;
        setAccount(result.snapshot);
        await refreshEnvironments();
        showMachinePicker();
      } catch {
        // Storage cleanup can be retried on the next lease check. A transient
        // account refresh is already represented as a non-throwing result.
      } finally {
        checkInFlight = false;
      }
    };

    void checkLease();
    const interval = window.setInterval(() => void checkLease(), ACCOUNT_LEASE_CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [accountClient, client, environments, refreshEnvironments, relayAccess, showMachinePicker, status.endpoint, status.selectedEnvId, status.state]);

  // ---- Chrome callbacks ---------------------------------------------------
  const onSwitchEnv = useCallback((environment: WebClientEnvironmentRecord) => {
    // Machine switches touch the whole graph (new catalog, new adapter binding);
    // persist the selection and cold-reboot for a clean connect.
    void client.switchEnvironment(environment.envId, relayAccess).catch(() => {});
    window.location.assign("/");
  }, [client, relayAccess]);

  const onForgetEnv = useCallback((environment: WebClientEnvironmentRecord) => {
    const wasActive = environment.envId === client.getStatus().selectedEnvId;
    void (async () => {
      await client.removeEnvironment(environment.envId);
      const remaining = await refreshEnvironments();
      if (wasActive || remaining.length === 0) window.location.assign("/");
    })();
  }, [client, refreshEnvironments]);

  const onSwitchProject = useCallback((project: SyncMobileProjectSummary) => {
    void (async () => {
      try {
        await client.switchProject(project.id);
        adapterRef.current?.bindProject(toProjectInfo(project));
      } catch {
        // switchProject surfaces its own failure via status; leave the app up.
      }
    })();
  }, [client]);

  const onPairNew = useCallback(() => showPairing(true), [showPairing]);

  const onAccountSignIn = useCallback(() => {
    void accountClient.startSignIn().catch((error) => {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        canRetry: false,
      });
    });
  }, [accountClient]);

  const onAccountSignOut = useCallback(() => {
    const snapshot = accountClient.signOut();
    void (async () => {
      client.disconnect();
      await applyAccountPrivacy(snapshot);
      showMachinePicker();
    })();
  }, [accountClient, applyAccountPrivacy, client, showMachinePicker]);

  const onRetryDirectory = useCallback(() => {
    setAccount((current) => ({ ...current, state: "loading", message: null }));
    void accountClient.loadMachines().then(applyAccountPrivacy).catch(() => {
      void applyAccountPrivacy(accountClient.getSnapshot());
    });
  }, [accountClient, applyAccountPrivacy]);

  // ---- Render -------------------------------------------------------------
  switch (phase.kind) {
    case "loading":
      return <Connecting name={null} />;
    case "connecting":
      return <Connecting name={phase.name} />;
    case "machine-picker":
      return (
        <MachinePicker
          environments={environments}
          account={account}
          relayAccess={relayAccess}
          connectingMachineKey={connectingAccountMachineKey}
          onSelect={(environment) => void connectTo(environment)}
          onSelectAccountMachine={(machine) => void connectToAccountMachine(machine)}
          onPair={() => showPairing(false)}
          onSignIn={onAccountSignIn}
          onSignOut={onAccountSignOut}
          onRetryDirectory={onRetryDirectory}
        />
      );
    case "pairing":
      return (
        <PairFlow
          client={client}
          hash={window.location.hash}
          relayAccess={relayAccess}
          onSignIn={onAccountSignIn}
          onBack={() => setPhase({ kind: "machine-picker" })}
          onPaired={() => {
            fatalRebootRef.current = false;
            // Consumed the pairing payload — clear it from the address bar.
            window.history.replaceState(null, "", "/");
            if (phase.reloadOnSuccess) {
              window.location.assign("/");
              return;
            }
            void (async () => {
              await refreshEnvironments();
              await afterConnect();
            })().catch((error) => {
              setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error), canRetry: false });
            });
          }}
        />
      );
    case "auth-required":
      return (
        <ScreenShell title="Sign in to connect" subtitle={phase.message}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {account.state !== "unconfigured" ? (
              <button type="button" style={primaryButton({ height: 36 })} onClick={onAccountSignIn}>
                {account.state === "signed_in" || account.state === "directory_unavailable" || account.state === "auth_expired"
                  ? "Sign in again"
                  : "Sign in"}
              </button>
            ) : null}
            <button
              type="button"
              style={primaryButton({ height: 36, background: "transparent", color: COLORS.textSecondary, border: `1px solid ${COLORS.border}` })}
              onClick={showMachinePicker}
            >
              Choose another Mac
            </button>
          </div>
        </ScreenShell>
      );
    case "project-picker":
      return (
        <ProjectPicker
          projects={phase.projects}
          machineName={status.hostName}
          onPick={(project) => {
            setPhase({ kind: "connecting", name: project.displayName });
            void enterProject(project, phase.projects).catch((error) => {
              setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error), canRetry: false });
            });
          }}
          onOpenChats={() => {
            setPhase({ kind: "connecting", name: "Chats" });
            void enterChats(phase.projects).catch((error) => {
              setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error), canRetry: false });
            });
          }}
        />
      );
    case "error":
      return (
        <ScreenShell title="Connection problem" subtitle={phase.message}>
          <div style={{ display: "flex", gap: 8 }}>
            {phase.canRetry && environments.length > 0 ? (
              <button type="button" style={primaryButton({ height: 36 })} onClick={() => void connectTo(environments[0])}>
                Retry
              </button>
            ) : null}
            <button
              type="button"
              style={primaryButton({ height: 36, background: "transparent", color: COLORS.textSecondary, border: `1px solid ${COLORS.border}` })}
              onClick={showMachinePicker}
            >
              Choose a machine
            </button>
          </div>
        </ScreenShell>
      );
    case "ready": {
      const AppRoot = phase.AppRoot;
      return (
        <WebShell
          status={status}
          environments={environments}
          activeEnvId={status.selectedEnvId}
          catalog={catalog}
          activeProjectId={status.activeProjectId}
          account={account}
          connectingAccountMachineKey={connectingAccountMachineKey}
          onSwitchEnv={onSwitchEnv}
          onSwitchAccountMachine={(machine) => void connectToAccountMachine(machine)}
          onPairNew={onPairNew}
          onAccountSignIn={onAccountSignIn}
          onAccountSignOut={onAccountSignOut}
          onRetryAccountDirectory={onRetryDirectory}
          onForgetEnv={onForgetEnv}
          onSwitchProject={onSwitchProject}
          onOpenChats={() => {
            window.history.pushState(null, "", "/chats");
            window.dispatchEvent(new PopStateEvent("popstate"));
          }}
        >
          <AppRoot />
        </WebShell>
      );
    }
  }
}

function Connecting({ name }: { name: string | null }) {
  return (
    <ScreenShell
      title={name ? `Connecting to ${name}` : "Starting ADE"}
      subtitle="Connecting to your machine…"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13 }}>
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: `2px solid color-mix(in srgb, var(--color-fg) 20%, transparent)`,
            borderTopColor: "var(--color-accent)",
            animation: "ade-web-spin 0.8s linear infinite",
          }}
        />
        Connecting…
        <style>{"@keyframes ade-web-spin { to { transform: rotate(360deg); } }"}</style>
      </div>
    </ScreenShell>
  );
}
