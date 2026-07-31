import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeeplinkTarget } from "../../../shared/deeplinks";
import type { WebClientEnvironmentRecord, WebRelayAccess, AdeSyncClient } from "../sync";
import {
  BrowserAccountClient,
  browserAccountIsSignedIn,
  type BrowserAccountSnapshot,
} from "../account/client";
import {
  accountLeaseOwnerForActiveConnection,
  reconcileActiveAccountLease,
} from "../account/leaseMonitor";
import type { FederatedWebAdapter } from "../adapter/federated";
import {
  WebWorkspaceProvider,
  type WebWorkspaceContextValue,
} from "../workspace/WebWorkspaceContext";
import { WebMachineSessionManager } from "../workspace/WebMachineSessionManager";
import { parseOpenTarget, parseWebPath, targetToWebPath } from "./webRoutes";
import { ScreenShell } from "./ScreenShell";
import { installSessionLifecycleChrome } from "./sessionLifecycleChrome";
import { COLORS, SANS_FONT, primaryButton } from "./shellTokens";

async function loadFederatedAdapter(
  manager: WebMachineSessionManager,
  accountClient: BrowserAccountClient,
  accountKey: string,
  fallbackClient: AdeSyncClient,
): Promise<FederatedWebAdapter> {
  const module = await import("../adapter/federated");
  return module.createFederatedWebAdapter({
    manager,
    accountClient,
    accountKey,
    fallbackClient,
  });
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
    // The persisted/default font size remains usable in hardened browsers.
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
  "/work",
  "/lanes",
  "/files",
  "/prs",
  "/review",
  "/history",
  "/automations",
  "/cto",
  "/settings",
  "/graph",
  "/chats",
];

function isAppRoute(pathname: string): boolean {
  return APP_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

function stashTarget(target: DeeplinkTarget | null): void {
  try {
    if (target) sessionStorage.setItem(PENDING_TARGET_KEY, JSON.stringify(target));
    else sessionStorage.removeItem(PENDING_TARGET_KEY);
  } catch {
    // A private browser may deny session storage.
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

function accountEnvironmentOwner(snapshot: BrowserAccountSnapshot): string | null {
  return browserAccountIsSignedIn(snapshot.state) ? snapshot.userId : null;
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
  if (browserAccountIsSignedIn(account.state) && account.userId) {
    return {
      kind: "signed_in",
      userId: account.userId,
      hostDeviceIds: account.machines.flatMap((machine) => machine.deviceId ? [machine.deviceId] : []),
      getAccessToken,
    };
  }
  return { kind: "signed_out" };
}

type Phase =
  | { kind: "signing-in" }
  | { kind: "booting"; message: string }
  | { kind: "ready"; AppRoot: React.ComponentType }
  | { kind: "error"; message: string };

export function WebClientRoot({
  client,
  accountClient: providedAccountClient,
}: {
  client: AdeSyncClient;
  accountClient?: BrowserAccountClient;
}) {
  const [accountClient] = useState(
    () => providedAccountClient ?? new BrowserAccountClient(),
  );
  const [sessionManager] = useState(
    () => new WebMachineSessionManager(client, accountClient),
  );
  const [phase, setPhase] = useState<Phase>(() => (
    window.location.pathname === "/account/callback"
      ? { kind: "signing-in" }
      : { kind: "booting", message: "Restoring your workspace…" }
  ));
  const [account, setAccount] = useState<BrowserAccountSnapshot>(
    () => accountClient.getSnapshot(),
  );
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(
    () => sessionManager.getSnapshot(),
  );
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [connectingMachineKey, setConnectingMachineKey] = useState<string | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [federatedAdapter, setFederatedAdapter] = useState<FederatedWebAdapter | null>(null);
  const [activeAdapterGeneration, setActiveAdapterGeneration] = useState(0);
  const federatedAdapterRef = useRef<FederatedWebAdapter | null>(null);
  const accountRef = useRef(account);
  const pendingTargetRef = useRef<DeeplinkTarget | null>(null);
  const workspaceSnapshotRef = useRef(workspaceSnapshot);
  accountRef.current = account;
  workspaceSnapshotRef.current = workspaceSnapshot;

  const applyAccountPrivacy = useCallback(async (
    snapshot: BrowserAccountSnapshot,
  ): Promise<WebClientEnvironmentRecord[]> => {
    const ownerUserId = accountEnvironmentOwner(snapshot);
    try {
      const result = await client.pruneAccountOwnedEnvironments(ownerUserId);
      setWorkspaceNotice(null);
      return environmentsVisibleToOwner(result.environments, ownerUserId);
    } catch {
      setWorkspaceNotice(
        "Browser-saved machines are temporarily unavailable. Account machines can still connect.",
      );
      return [];
    }
  }, [client]);

  const refreshVisibleEnvironments = useCallback(async () => {
    const environments = await sessionManager.refreshEnvironments();
    const visible = environmentsVisibleToOwner(
      environments,
      accountEnvironmentOwner(accountRef.current),
    );
    sessionManager.replaceEnvironments(visible);
    return visible;
  }, [sessionManager]);

  useEffect(() => sessionManager.subscribe(setWorkspaceSnapshot), [sessionManager]);

  const relayAccess = useMemo(
    () => relayAccessFromAccount(account, () => accountClient.getAccessToken()),
    [account, accountClient],
  );

  useEffect(() => {
    sessionManager.setRelayAccess(relayAccess);
  }, [relayAccess, sessionManager]);

  useEffect(() => {
    let disposed = false;
    let checkInFlight = false;
    const checkLeases = async () => {
      if (disposed || checkInFlight) return;
      checkInFlight = true;
      try {
        for (const session of workspaceSnapshotRef.current.sessions) {
          if (session.state !== "live" && session.state !== "reconnecting") continue;
          const expectedOwnerUserId = accountLeaseOwnerForActiveConnection({
            environment: session.environment,
            endpoint: session.status.endpoint,
            relayAccess,
          });
          const syncClient = sessionManager.getClient(session.targetId);
          if (!expectedOwnerUserId || !syncClient) continue;
          const result = await reconcileActiveAccountLease({
            accountClient,
            syncClient,
            expectedOwnerUserId,
          });
          if (result.state !== "revoked") continue;
          setAccount(result.snapshot);
          const visible = await applyAccountPrivacy(result.snapshot);
          sessionManager.replaceEnvironments(visible);
          break;
        }
      } catch {
        // A transient refresh/storage failure is retried on the next lease check.
      } finally {
        checkInFlight = false;
      }
    };
    void checkLeases();
    const interval = window.setInterval(
      () => void checkLeases(),
      ACCOUNT_LEASE_CHECK_INTERVAL_MS,
    );
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [accountClient, applyAccountPrivacy, relayAccess, sessionManager]);

  const activeTargetId = workspaceSnapshot.activeTargetId;
  const activeLifecycleClient = activeTargetId
    ? sessionManager.getClient(activeTargetId)
    : null;
  useEffect(() => {
    if (!activeLifecycleClient) return;
    return installSessionLifecycleChrome(activeLifecycleClient);
  }, [activeLifecycleClient, activeTargetId]);

  useEffect(() => {
    let disposed = false;
    let mountedAdapter: FederatedWebAdapter | null = null;
    let activeAdapterDispose = () => {};

    void (async () => {
      if (window.location.pathname === "/pair") {
        window.history.replaceState(null, "", "/");
      }
      const path = window.location.pathname;
      const pendingTarget = path === "/open"
        ? parseOpenTarget(window.location.search)
        : isAppRoute(path)
          ? parseWebPath(`${path}${window.location.search}`)
          : readStashedTarget();
      pendingTargetRef.current = pendingTarget;
      stashTarget(pendingTarget);

      const snapshot = await accountClient.bootstrap();
      if (disposed) return;
      setAccount(snapshot);
      setPhase({ kind: "booting", message: "Opening the workspace Hub…" });

      const environments = await applyAccountPrivacy(snapshot);
      if (disposed) return;
      sessionManager.replaceEnvironments(environments);
      sessionManager.setRelayAccess(
        relayAccessFromAccount(snapshot, () => accountClient.getAccessToken()),
      );

      const adapter = await loadFederatedAdapter(
        sessionManager,
        accountClient,
        snapshot.userId?.trim() || "signed-out",
        client,
      );
      if (disposed) {
        adapter.dispose();
        return;
      }
      federatedAdapterRef.current = adapter;
      mountedAdapter = adapter;
      activeAdapterDispose = adapter.subscribeActiveAdapter(() => {
        setActiveAdapterGeneration((generation) => generation + 1);
      });
      setFederatedAdapter(adapter);
      window.ade = adapter.ade;

      const restored = await adapter.restore();
      if (disposed) return;
      const restoredTarget = readStashedTarget();
      const initialPath = restored
        ? restoredTarget
          ? targetToWebPath(restoredTarget)
          : isAppRoute(path)
            ? `${path}${window.location.search}`
            : "/work"
        : "/hub";
      if (restored) {
        pendingTargetRef.current = null;
        stashTarget(null);
      }
      window.history.replaceState(null, "", initialPath);
      const AppRoot = await loadAppRoot();
      if (!disposed) setPhase({ kind: "ready", AppRoot });
    })().catch((error) => {
      if (disposed) return;
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      disposed = true;
      activeAdapterDispose();
      mountedAdapter?.dispose();
      if (federatedAdapterRef.current === mountedAdapter) {
        federatedAdapterRef.current = null;
      }
      sessionManager.dispose();
    };
  }, [accountClient, applyAccountPrivacy, client, sessionManager]);

  const signIn = useCallback(() => {
    void accountClient.startSignIn().catch((error) => {
      setWorkspaceNotice(error instanceof Error ? error.message : String(error));
    });
  }, [accountClient]);

  const workspaceContext = useMemo<WebWorkspaceContextValue | null>(() => {
    const adapter = federatedAdapter;
    if (!adapter) return null;
    return {
      account,
      snapshot: workspaceSnapshot,
      manager: sessionManager,
      adapter,
      connectingMachineKey,
      directoryLoading,
      notice: workspaceNotice,
      dismissNotice: () => setWorkspaceNotice(null),
      consumePendingProjectPath() {
        const target = pendingTargetRef.current ?? readStashedTarget();
        if (!target) return null;
        pendingTargetRef.current = null;
        stashTarget(null);
        return targetToWebPath(target);
      },
      signIn,
      async signOut() {
        const snapshot = await accountClient.signOut();
        setAccount(snapshot);
        for (const session of sessionManager.getSnapshot().sessions) {
          await sessionManager.park(session.targetId);
        }
        const visible = await applyAccountPrivacy(snapshot);
        sessionManager.replaceEnvironments(visible);
      },
      async retryDirectory() {
        setDirectoryLoading(true);
        try {
          const snapshot = await accountClient.loadMachines();
          setAccount(snapshot);
          const visible = await applyAccountPrivacy(snapshot);
          sessionManager.replaceEnvironments(visible);
        } finally {
          setDirectoryLoading(false);
        }
      },
      async connectAccountMachine(machine) {
        setConnectingMachineKey(machine.machineKey);
        try {
          const session = await sessionManager.connectAccountMachine(machine);
          await refreshVisibleEnvironments();
          return session.targetId;
        } finally {
          setConnectingMachineKey(null);
        }
      },
      async connectEnvironment(targetId) {
        await sessionManager.connectEnvironment(targetId);
      },
      async renameMachine(machineKey, customName) {
        await accountClient.renameMachine(machineKey, customName);
        setAccount(accountClient.getSnapshot());
      },
      async removeAccountMachine(machineKey) {
        await accountClient.removeMachine(machineKey);
        const snapshot = accountClient.getSnapshot();
        setAccount(snapshot);
        const visible = await applyAccountPrivacy(snapshot);
        sessionManager.replaceEnvironments(visible);
      },
      async forgetEnvironment(targetId) {
        await adapter.forgetEnvironment(targetId);
        await refreshVisibleEnvironments();
      },
    };
  }, [
    account,
    accountClient,
    applyAccountPrivacy,
    connectingMachineKey,
    directoryLoading,
    federatedAdapter,
    refreshVisibleEnvironments,
    sessionManager,
    signIn,
    workspaceNotice,
    workspaceSnapshot,
  ]);

  switch (phase.kind) {
    case "signing-in":
      return <ProgressScreen title="Signing in…" message="Completing secure sign-in…" />;
    case "booting":
      return <ProgressScreen title="Starting ADE" message={phase.message} />;
    case "error":
      return (
        <ScreenShell title="ADE Web couldn't start" subtitle={phase.message}>
          <button
            type="button"
            style={primaryButton({ height: 36 })}
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </ScreenShell>
      );
    case "ready": {
      if (!workspaceContext) {
        return <ProgressScreen title="Starting ADE" message="Preparing your workspace…" />;
      }
      const AppRoot = phase.AppRoot;
      return (
        <WebWorkspaceProvider value={workspaceContext}>
          <AppRoot key={activeAdapterGeneration} />
        </WebWorkspaceProvider>
      );
    }
  }
}

function ProgressScreen({ title, message }: { title: string; message: string }) {
  return (
    <ScreenShell title={title} subtitle={message}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: COLORS.textSecondary,
          fontFamily: SANS_FONT,
          fontSize: 13,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "2px solid color-mix(in srgb, var(--color-fg) 20%, transparent)",
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
