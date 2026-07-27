import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "../../../shared/types";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type { DeeplinkTarget } from "../../../shared/deeplinks";
import type {
  AdeSyncActiveProjectChange,
  AdeSyncClient,
  AdeSyncClientStatus,
  WebRelayAccess,
  WebClientEnvironmentRecord,
} from "../sync";
import { WebRelayAuthRequiredError } from "../sync";
import {
  BrowserAccountClient,
  browserAccountIsSignedIn,
  type BrowserAccountSnapshot,
} from "../account/client";
import {
  accountLeaseOwnerForActiveConnection,
  reconcileActiveAccountLease,
} from "../account/leaseMonitor";
import { parseOpenTarget, parseWebPath, targetToWebPath } from "./webRoutes";
import { ScreenShell } from "./ScreenShell";
import { ProjectPicker } from "./ProjectPicker";
import { WebShell } from "./WebShell";
import { MachinePicker } from "./MachinePicker";
import { COLORS, SANS_FONT, primaryButton } from "./shellTokens";

type AdeWebAdapter = {
  ade: Window["ade"];
  bindProject: (project: ProjectInfo | null, projectId?: string | null) => void;
  replaceProject: (project: ProjectInfo, projectId: string) => void;
  dispose: () => void;
};

async function loadAdapter(
  client: AdeSyncClient,
  accountClient: BrowserAccountClient,
  initialCatalog?: SyncMobileProjectSummary[],
): Promise<AdeWebAdapter> {
  const module = await import("../adapter/index");
  return module.createAdeWebAdapter(client, initialCatalog, accountClient);
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
  "/automations", "/cto", "/settings", "/graph", "/chats",
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
  | { kind: "signing-in" }
  | { kind: "booting"; message: string }
  | { kind: "machine-picker" }
  | { kind: "connecting"; name: string }
  | { kind: "auth-required"; message: string }
  | { kind: "project-picker"; projects: SyncMobileProjectSummary[] }
  | { kind: "ready"; AppRoot: React.ComponentType }
  | { kind: "error"; message: string; canRetry: boolean };

type SavedEnvironmentsState = "loading" | "ready" | "unavailable";

function accountEnvironmentOwner(snapshot: BrowserAccountSnapshot): string | null {
  return (
    snapshot.state === "signed_in" || snapshot.state === "directory_unavailable"
  )
    ? snapshot.userId
    : null;
}

function environmentsVisibleToOwner(
  environments: WebClientEnvironmentRecord[],
  ownerUserId: string | null,
): WebClientEnvironmentRecord[] {
  if (!ownerUserId) return environments;
  return environments.filter((environment) => (
    environment.accountOwnerUserId == null
    || environment.accountOwnerUserId === ownerUserId
  ));
}

function relayAccessFromAccount(
  account: BrowserAccountSnapshot,
  getAccessToken: () => Promise<string>,
): WebRelayAccess {
  if (
    browserAccountIsSignedIn(account.state)
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
  const [phase, setPhase] = useState<Phase>(() => (
    window.location.pathname === "/account/callback"
      ? { kind: "signing-in" }
      : { kind: "machine-picker" }
  ));
  const [status, setStatus] = useState<AdeSyncClientStatus>(() => client.getStatus());
  const [storedEnvironments, setStoredEnvironments] = useState<WebClientEnvironmentRecord[]>([]);
  const [savedEnvironmentsState, setSavedEnvironmentsState] = useState<SavedEnvironmentsState>("loading");
  const [savedEnvironmentsOwner, setSavedEnvironmentsOwner] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<SyncMobileProjectSummary[]>([]);
  const [account, setAccount] = useState<BrowserAccountSnapshot>(() => accountClient.getSnapshot());
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [connectingAccountMachineKey, setConnectingAccountMachineKey] = useState<string | null>(null);

  const adapterRef = useRef<AdeWebAdapter | null>(null);
  const activeProjectBoundaryRef = useRef<AdeSyncActiveProjectChange | null>(null);
  const stashedTargetRef = useRef<DeeplinkTarget | null>(null);
  const bootedRef = useRef(false);
  const fatalRebootRef = useRef(false);
  const phaseIsReadyRef = useRef(false);
  const connectingAccountMachineRef = useRef<string | null>(null);
  const accountRef = useRef(account);
  const savedEnvironmentsLoadRef = useRef(0);
  const privacyReadyOwnerRef = useRef<{ ownerUserId: string | null } | null>(null);
  const pendingEnvironmentRefreshRef = useRef<{
    ownerUserId: string | null;
    environments: WebClientEnvironmentRecord[];
  } | null>(null);
  phaseIsReadyRef.current = phase.kind === "ready";
  accountRef.current = account;
  const currentAccountOwner = accountEnvironmentOwner(account);
  const environments = savedEnvironmentsState === "ready"
    && savedEnvironmentsOwner === currentAccountOwner
    ? storedEnvironments
    : [];
  const relayAccess = useMemo(
    () => relayAccessFromAccount(account, () => accountClient.getAccessToken()),
    [account, accountClient],
  );

  const refreshEnvironments = useCallback(async () => {
    try {
      const list = await client.listEnvironments();
      const ownerUserId = accountEnvironmentOwner(accountRef.current);
      const visibleList = environmentsVisibleToOwner(list, ownerUserId);
      pendingEnvironmentRefreshRef.current = { ownerUserId, environments: visibleList };
      if (privacyReadyOwnerRef.current?.ownerUserId === ownerUserId) {
        setStoredEnvironments(visibleList);
        setSavedEnvironmentsOwner(ownerUserId);
        setSavedEnvironmentsState("ready");
      }
      return visibleList;
    } catch (error) {
      setStoredEnvironments([]);
      setSavedEnvironmentsOwner(accountEnvironmentOwner(accountRef.current));
      setSavedEnvironmentsState("unavailable");
      throw error;
    }
  }, [client]);

  const applyAccountPrivacy = useCallback(async (
    snapshot: BrowserAccountSnapshot,
  ): Promise<WebClientEnvironmentRecord[]> => {
    const loadId = ++savedEnvironmentsLoadRef.current;
    const currentOwnerUserId = accountEnvironmentOwner(snapshot);
    privacyReadyOwnerRef.current = null;
    pendingEnvironmentRefreshRef.current = null;
    setStoredEnvironments([]);
    setSavedEnvironmentsOwner(currentOwnerUserId);
    setSavedEnvironmentsState("loading");
    setAccount(snapshot);
    try {
      const result = await client.pruneAccountOwnedEnvironments(currentOwnerUserId);
      const survivingEnvironments = result.environments;
      if (savedEnvironmentsLoadRef.current === loadId) {
        privacyReadyOwnerRef.current = { ownerUserId: currentOwnerUserId };
        const pendingRefresh = pendingEnvironmentRefreshRef.current as {
          ownerUserId: string | null;
          environments: WebClientEnvironmentRecord[];
        } | null;
        const visibleEnvironments = pendingRefresh?.ownerUserId === currentOwnerUserId
          ? pendingRefresh.environments
          : environmentsVisibleToOwner(survivingEnvironments, currentOwnerUserId);
        setStoredEnvironments(visibleEnvironments);
        setSavedEnvironmentsOwner(currentOwnerUserId);
        setSavedEnvironmentsState("ready");
      }
      return survivingEnvironments;
    } catch {
      if (savedEnvironmentsLoadRef.current === loadId) {
        privacyReadyOwnerRef.current = null;
        setStoredEnvironments([]);
        setSavedEnvironmentsOwner(currentOwnerUserId);
        setSavedEnvironmentsState("unavailable");
      }
      return [];
    }
  }, [client]);

  const showMachinePicker = useCallback(() => {
    fatalRebootRef.current = false;
    setPhase({ kind: "machine-picker" });
  }, []);

  // Bring the connected machine's catalog + selected project online, then mount
  // the shared App with the sync-backed adapter installed on window.ade.
  const enterProject = useCallback(async (project: SyncMobileProjectSummary, catalogSeed?: SyncMobileProjectSummary[]) => {
    const pendingBoundary = activeProjectBoundaryRef.current;
    const projectToEnter = pendingBoundary?.project.id === client.getStatus().activeProjectId
      ? pendingBoundary.project
      : project;
    // Switch onto the target project's host only when it isn't already the
    // active one. The host serves file_request/commands for the peer's bound
    // project without a redundant switch, so avoid the extra disconnect +
    // reconnect (and its startup latency) when we're already on this project.
    if (projectToEnter.id !== client.getStatus().activeProjectId) {
      const result = await client.switchProject(projectToEnter.id);
      if (!result.ok) {
        throw new Error(result.message?.trim() || `Could not switch to ${projectToEnter.displayName}.`);
      }
    }
    if (!adapterRef.current) {
      adapterRef.current = await loadAdapter(client, accountClient, catalogSeed);
    }
    window.ade = adapterRef.current.ade;
    const latestBoundary = activeProjectBoundaryRef.current;
    const projectToBind = latestBoundary?.project.id === client.getStatus().activeProjectId
      ? latestBoundary.project
      : projectToEnter;
    activeProjectBoundaryRef.current = null;
    adapterRef.current.bindProject(toProjectInfo(projectToBind), projectToBind.id);

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
  }, [accountClient, client]);

  const enterChats = useCallback(async (
    catalogSeed?: SyncMobileProjectSummary[],
    initialPath = "/chats",
  ) => {
    if (!adapterRef.current) {
      adapterRef.current = await loadAdapter(client, accountClient, catalogSeed);
    }
    window.ade = adapterRef.current.ade;
    adapterRef.current.bindProject(null);
    stashedTargetRef.current = null;
    stashTarget(null);
    window.history.replaceState(null, "", initialPath);
    const AppRoot = await loadAppRoot();
    setPhase({ kind: "ready", AppRoot });
  }, [accountClient, client]);

  const afterConnect = useCallback(async (environmentSeed?: WebClientEnvironmentRecord[]) => {
    const availableEnvironments = environmentSeed ?? await client.listEnvironments();
    const activeEnv = availableEnvironments.find(
      (environment) => environment.envId === client.getStatus().selectedEnvId,
    ) ?? null;
    const fetchedProjects = (await client.getProjectCatalog()).projects;
    const pendingBoundary = activeProjectBoundaryRef.current;
    const projects = pendingBoundary?.project.id === client.getStatus().activeProjectId
      ? pendingBoundary.catalog.projects
      : fetchedProjects;
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
      setPhase({ kind: "booting", message: "Opening your workspace…" });
      const refreshed = await refreshEnvironments();
      await afterConnect(refreshed);
    } catch (error) {
      if (error instanceof WebRelayAuthRequiredError) {
        setPhase({ kind: "auth-required", message: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setPhase({ kind: "error", message, canRetry: true });
    }
  }, [client, relayAccess, afterConnect, refreshEnvironments]);

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
      setPhase({ kind: "booting", message: "Opening your workspace…" });
      const refreshed = await refreshEnvironments();
      await afterConnect(refreshed);
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
    let disposed = false;
    let accountProgressInterval: number | null = null;
    void (async () => {
      // Older native clients may still open the retired web pairing URL. Treat
      // it as the normal sign-in entry and scrub the obsolete payload.
      if (window.location.pathname === "/pair") {
        window.history.replaceState(null, "", "/");
      }
      const path = window.location.pathname;
      if (path === "/open") {
        stashedTargetRef.current = parseOpenTarget(window.location.search);
        stashTarget(stashedTargetRef.current);
      } else if (isAppRoute(path)) {
        stashedTargetRef.current = parseWebPath(`${path}${window.location.search}`);
      } else {
        stashedTargetRef.current = readStashedTarget();
      }

      let privacyStartedFor: string | null | undefined;
      const beginPrivacyLoad = (snapshot: BrowserAccountSnapshot) => {
        const ownerUserId = accountEnvironmentOwner(snapshot);
        if (privacyStartedFor === ownerUserId) return;
        privacyStartedFor = ownerUserId;
        void applyAccountPrivacy(snapshot);
      };

      if (path === "/account/callback") {
        // bootstrap() performs token exchange and then the directory request.
        // Observe the account snapshot so the UI can distinguish those stages
        // without coupling either one to browser storage.
        accountProgressInterval = window.setInterval(() => {
          const pendingSnapshot = accountClient.getSnapshot();
          if (
            pendingSnapshot.userId
            && (pendingSnapshot.state === "signed_in" || pendingSnapshot.state === "directory_unavailable")
          ) {
            setAccount(pendingSnapshot);
            setDirectoryLoading(true);
            setPhase({ kind: "machine-picker" });
            beginPrivacyLoad(pendingSnapshot);
          }
        }, 150);
      }

      const accountSnapshot = await accountClient.bootstrap();
      if (disposed) return;
      if (accountProgressInterval != null) {
        window.clearInterval(accountProgressInterval);
        accountProgressInterval = null;
      }
      setAccount(accountSnapshot);
      setDirectoryLoading(false);
      setPhase({ kind: "machine-picker" });
      beginPrivacyLoad(accountSnapshot);
    })().catch(() => {
      if (accountProgressInterval != null) {
        window.clearInterval(accountProgressInterval);
        accountProgressInterval = null;
      }
      if (disposed) return;
      const accountSnapshot = accountClient.getSnapshot();
      setAccount(accountSnapshot);
      setDirectoryLoading(false);
      setPhase({ kind: "machine-picker" });
      void applyAccountPrivacy(accountSnapshot);
    });
    return () => {
      disposed = true;
      if (accountProgressInterval != null) window.clearInterval(accountProgressInterval);
    };
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

  useEffect(() => {
    return client.onActiveProjectChanged((change) => {
      const { project, catalog: nextCatalog } = change;
      setCatalog(nextCatalog.projects);
      // Personal Chats is intentionally machine-scoped and projectless. Keep
      // its mounted adapter detached even when the machine hands the shared
      // listener to another open project.
      if (isChatsRoute(window.location.pathname)) {
        activeProjectBoundaryRef.current = null;
        return;
      }
      const adapter = adapterRef.current;
      if (!adapter) {
        activeProjectBoundaryRef.current = change;
        return;
      }
      activeProjectBoundaryRef.current = null;
      adapter.replaceProject(toProjectInfo(project), project.id);
    });
  }, [client]);

  // Account-owned trust and account-authorized Relay sockets stay usable only
  // while the same browser account remains valid. A local pairing keeps its
  // saved trust after Relay logout so it can reconnect directly later.
  useEffect(() => {
    if (
      status.state !== "connecting"
      && status.state !== "connected"
      && status.state !== "restoring"
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
        const result = await client.switchProject(project.id);
        if (!result.ok) return;
        adapterRef.current?.replaceProject(toProjectInfo(project), result.project?.id ?? project.id);
      } catch {
        // switchProject surfaces its own failure via status; leave the app up.
      }
    })();
  }, [client]);

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
    void (async () => {
      const snapshot = await accountClient.signOut();
      client.disconnect();
      await applyAccountPrivacy(snapshot);
      showMachinePicker();
    })();
  }, [accountClient, applyAccountPrivacy, client, showMachinePicker]);

  const onRetryDirectory = useCallback(() => {
    setDirectoryLoading(true);
    void accountClient.loadMachines().then((snapshot) => {
      setAccount(snapshot);
      setDirectoryLoading(false);
      void applyAccountPrivacy(snapshot);
    }).catch(() => {
      const snapshot = accountClient.getSnapshot();
      setAccount(snapshot);
      setDirectoryLoading(false);
      void applyAccountPrivacy(snapshot);
    });
  }, [accountClient, applyAccountPrivacy]);

  const onRetrySavedEnvironments = useCallback(() => {
    void applyAccountPrivacy(accountRef.current);
  }, [applyAccountPrivacy]);

  // ---- Render -------------------------------------------------------------
  switch (phase.kind) {
    case "signing-in":
      return <ProgressScreen title="Signing in…" message="Completing secure sign-in…" />;
    case "booting":
      return <ProgressScreen title="Starting ADE" message={phase.message} />;
    case "connecting":
      return <Connecting name={phase.name} />;
    case "machine-picker":
      return (
        <MachinePicker
          environments={environments}
          account={account}
          relayAccess={relayAccess}
          connectingMachineKey={connectingAccountMachineKey}
          directoryLoading={directoryLoading}
          savedEnvironmentsState={savedEnvironmentsState}
          onSelect={(environment) => void connectTo(environment)}
          onSelectAccountMachine={(machine) => void connectToAccountMachine(machine)}
          onSignIn={onAccountSignIn}
          onSignOut={onAccountSignOut}
          onRetryDirectory={onRetryDirectory}
          onRetrySavedEnvironments={onRetrySavedEnvironments}
        />
      );
    case "auth-required":
      return (
        <ScreenShell title="Sign in to connect" subtitle={phase.message}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {account.state !== "unconfigured" ? (
              <button type="button" style={primaryButton({ height: 36 })} onClick={onAccountSignIn}>
                {browserAccountIsSignedIn(account.state) || account.state === "auth_expired"
                  ? "Sign in again"
                  : "Sign in"}
              </button>
            ) : null}
            <button
              type="button"
              style={primaryButton({ height: 36, background: "transparent", color: COLORS.textSecondary, border: `1px solid ${COLORS.border}` })}
              onClick={showMachinePicker}
            >
              Choose another machine
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
            setPhase({ kind: "booting", message: `Opening ${project.displayName}…` });
            void enterProject(project, phase.projects).catch((error) => {
              setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error), canRetry: false });
            });
          }}
          onOpenChats={() => {
            setPhase({ kind: "booting", message: "Opening Chats…" });
            void enterChats(phase.projects).catch((error) => {
              setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error), canRetry: false });
            });
          }}
        />
      );
    case "error":
      return (
        <ScreenShell title="Can't reach this Mac" subtitle={phase.message}>
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

function ProgressScreen({ title, message }: { title: string; message: string }) {
  return (
    <ScreenShell
      title={title}
      subtitle={message}
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
        {message}
        <style>{"@keyframes ade-web-spin { to { transform: rotate(360deg); } }"}</style>
      </div>
    </ScreenShell>
  );
}

function Connecting({ name }: { name: string }) {
  return (
    <ProgressScreen
      title={`Reconnecting to ${name}…`}
      message="Establishing a secure connection…"
    />
  );
}
