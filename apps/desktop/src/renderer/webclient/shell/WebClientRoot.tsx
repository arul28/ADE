import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseDeeplink, type DeeplinkTarget } from "../../../shared/deeplinks";
import type { WebClientEnvironmentRecord, WebRelayAccess, AdeSyncClient } from "../sync";
import { WebClientEnvStore } from "../sync";
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
import type { WebMachineEntry } from "../workspace/webWorkspaceModel";
import { WebMachineSessionManager } from "../workspace/WebMachineSessionManager";
import { mergeWebMachines, webMachineCatalogKeys } from "../workspace/webWorkspaceModel";
import { createAccountNamespace } from "../adapter/account";
import { parseOpenTarget, parseWebPath, targetToWebPath } from "./webRoutes";
import { readPendingTarget, stashPendingTarget } from "./pendingTarget";
import {
  matchOwnedProject,
  navigateMountedApp,
  ownedLinkStageText,
  ownershipOfTarget,
  resolveOwnedLink,
  type OwnedLinkResult,
} from "./ownedLinkResolution";
import type { WebOwnedLinkState } from "../workspace/WebWorkspaceContext";
import { ScreenShell } from "./ScreenShell";
import { installSessionLifecycleChrome } from "./sessionLifecycleChrome";
import { COLORS, SANS_FONT, primaryButton } from "./shellTokens";

async function loadFederatedAdapter(
  manager: WebMachineSessionManager,
  accountClient: BrowserAccountClient,
  accountKey: string,
  fallbackClient: AdeSyncClient,
  openOwnedDeeplink: (url: string) => Promise<boolean>,
): Promise<FederatedWebAdapter> {
  const module = await import("../adapter/federated");
  return module.createFederatedWebAdapter({
    manager,
    accountClient,
    accountKey,
    fallbackClient,
    openOwnedDeeplink,
  });
}

/**
 * Loads the app's full stylesheet. The entry ships only `gate.css` (the boot
 * screens and the sign-in card), so the workspace waits for this before its
 * first render. Callers start it before the app's own modules: stylesheets
 * apply in the order their links are added, and the app's stylesheet came
 * ahead of every chunk stylesheet when the entry carried it.
 */
function loadAppStylesheet(): Promise<unknown> {
  return import("../../index.css");
}

async function loadAppRoot(): Promise<React.ComponentType> {
  const [, { App }, { RendererErrorBoundary }, { useAppStore }, { WebOwnedLinkBanner }] = await Promise.all([
    loadAppStylesheet(),
    import("../../components/app/App"),
    import("../../components/app/RendererErrorBoundary"),
    import("../../state/appStore"),
    import("./WebOwnedLinkBanner"),
  ]);
  try {
    useAppStore.getState().applyAutoSizeChatFontOnLargeScreenIfNotOverridden();
  } catch {
    // The persisted/default font size remains usable in hardened browsers.
  }
  return function MountedApp() {
    return (
      <RendererErrorBoundary>
        <WebOwnedLinkBanner />
        <App />
      </RendererErrorBoundary>
    );
  };
}

/**
 * Starts downloading the signed-in workspace. Module imports are cached, so the
 * later awaits in `installFederatedAdapter` and `loadAppRoot` resolve at once.
 * Only called when a stored session says the workspace is coming.
 */
function preloadWorkspaceModules(): void {
  void Promise.all([
    loadAppStylesheet(),
    import("../adapter/federated"),
    import("../../components/app/App"),
    import("../../components/app/RendererErrorBoundary"),
    import("../../state/appStore"),
  ]).catch(() => undefined);
}

const ACCOUNT_LEASE_CHECK_INTERVAL_MS = 30_000;
/**
 * Where a boot with nothing to restore lands. The shared App renders its
 * project welcome surface on any app route while no project is open, so the
 * hosted client has no separate landing route — and no Hub.
 */
const WELCOME_PATH = "/work";
/** Retired routes that must not survive a reload. */
const LEGACY_PATHS = new Set(["/pair", "/hub"]);
const APP_ROUTE_ROOTS = [
  "/work",
  // Activity is a modal, but its pathname is a real deep link the shell turns
  // back into one. Without these two a hard reload on the hosted client drops
  // the user at the sign-in shell instead of the app.
  "/activity",
  "/attention",
  "/lanes",
  "/files",
  "/prs",
  "/history",
  "/automations",
  "/cto",
  "/settings",
  "/chats",
];

function isAppRoute(pathname: string): boolean {
  return APP_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

function accountEnvironmentOwner(snapshot: BrowserAccountSnapshot): string | null {
  return browserAccountIsSignedIn(snapshot.state) ? snapshot.userId : null;
}

function accountWorkspaceKey(snapshot: BrowserAccountSnapshot): string {
  return browserAccountIsSignedIn(snapshot.state) && snapshot.userId?.trim()
    ? snapshot.userId.trim()
    : "signed-out";
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
  /** `done` lists the finished steps of a link that is opening, oldest first. */
  | { kind: "booting"; message: string; title?: string; done?: readonly string[] }
  | { kind: "signed-out"; SignIn: React.ComponentType }
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
  // The catalog cache is its own store instance: it holds no credentials, so it
  // must not wait behind the sync client's environment/trust bookkeeping.
  const [catalogStore] = useState(() => new WebClientEnvStore());
  const [sessionManager] = useState(
    () => new WebMachineSessionManager(client, accountClient, undefined, catalogStore),
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
  const [ownedLink, setOwnedLink] = useState<WebOwnedLinkState | null>(null);
  const ownedLinkRunRef = useRef(0);
  const [federatedAdapter, setFederatedAdapter] = useState<FederatedWebAdapter | null>(null);
  const [activeAdapterGeneration, setActiveAdapterGeneration] = useState(0);
  // Remounting the app tree is reserved for a genuinely different workspace —
  // a new federated adapter, i.e. a different account, where `window.ade`
  // itself is replaced. Switching tabs swaps the adapter *behind* the stable
  // surface proxy, and the proxy re-attaches every unpinned subscription to the
  // newly displayed adapter (see `setCurrentAdapter` in adapter/federated.ts),
  // so the tree stays mounted and keeps its per-tab state.
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const federatedAdapterRef = useRef<FederatedWebAdapter | null>(null);
  const federatedAccountKeyRef = useRef<string | null>(null);
  const federatedAdapterDisposeRef = useRef<() => void>(() => {});
  const federatedAdapterGenerationRef = useRef(0);
  const accountRef = useRef(account);
  const pendingTargetRef = useRef<DeeplinkTarget | null>(null);
  const workspaceSnapshotRef = useRef(workspaceSnapshot);
  accountRef.current = account;
  workspaceSnapshotRef.current = workspaceSnapshot;

  const applyAccountPrivacy = useCallback(async (
    snapshot: BrowserAccountSnapshot,
  ): Promise<WebClientEnvironmentRecord[]> => {
    const ownerUserId = accountEnvironmentOwner(snapshot);
    // Cached project names are account data too: drop another account's before
    // this one's recents are allowed to paint.
    try {
      await catalogStore.pruneMachineCatalogs(ownerUserId);
    } catch {
      // Without browser storage there is nothing cached to leak.
    }
    await sessionManager.hydrateCatalogs(ownerUserId);
    try {
      const result = await client.pruneAccountOwnedEnvironments(ownerUserId);
      setWorkspaceNotice(null);
      try {
        await client.adoptDirectoryTailnetRoutes(snapshot.machines, ownerUserId, snapshot.relayBaseUrls);
      } catch (error) {
        // The saved routes stay as they were; the next directory read tries again.
        console.warn("[ade-web] couldn't update saved Tailscale routes", error);
      }
      return environmentsVisibleToOwner(result.environments, ownerUserId);
    } catch {
      setWorkspaceNotice(
        "Browser-saved machines are temporarily unavailable. Account machines can still connect.",
      );
      return [];
    }
  }, [catalogStore, client, sessionManager]);

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

  const connectMachineEntry = useCallback(async (machine: WebMachineEntry): Promise<string> => {
    if (machine.session?.state === "live") return machine.session.targetId;
    if (machine.environment) {
      await sessionManager.connectEnvironment(machine.environment.envId);
      return machine.environment.envId;
    }
    if (machine.accountMachine) {
      setConnectingMachineKey(machine.accountMachine.machineKey);
      try {
        const session = await sessionManager.connectAccountMachine(machine.accountMachine);
        await refreshVisibleEnvironments();
        return session.targetId;
      } finally {
        setConnectingMachineKey(null);
      }
    }
    throw new Error("This machine has no connection ADE Web can dial.");
  }, [refreshVisibleEnvironments, sessionManager]);

  /** The account's machines merged with the live sessions, read fresh. */
  const currentMachines = useCallback(() => mergeWebMachines({
    accountMachines: accountClient.getSnapshot().machines,
    snapshot: sessionManager.getSnapshot(),
    relayBaseUrls: accountClient.getRelayBaseUrls(),
  }), [accountClient, sessionManager]);

  const clearPendingTarget = useCallback(() => {
    pendingTargetRef.current = null;
    stashPendingTarget(null);
  }, []);

  /**
   * Record an owned link's outcome. Returns the route to land on (its item,
   * or its project when only the item is gone), or null to stay where the
   * person was with the link still pending.
   */
  const settleOwnedLink = useCallback((result: OwnedLinkResult): string | null => {
    if (result.ok) {
      setOwnedLink(null);
      clearPendingTarget();
      return result.path;
    }
    setOwnedLink({ status: "failed", failure: result.failure });
    if (!result.failure.projectPath) return null;
    clearPendingTarget();
    return result.failure.projectPath;
  }, [clearPendingTarget]);

  /**
   * Open an owned link on its machine and project (see ownedLinkResolution.ts).
   * `onStage` reports each step; the result is the route or the failure.
   */
  const resolveOwnedTarget = useCallback(async (
    target: DeeplinkTarget,
    adapter: FederatedWebAdapter,
    onStage: (message: string) => void,
  ): Promise<OwnedLinkResult | null> => {
    const ownership = ownershipOfTarget(target);
    if (!ownership) return null;
    return await resolveOwnedLink(target, ownership, {
      machines: currentMachines,
      directoryUnavailable: () => accountClient.getSnapshot().state === "directory_unavailable",
      connect: connectMachineEntry,
      catalog: (targetId) => sessionManager.getSession(targetId)?.projects ?? [],
      // The manager skips the switch when the project is already the open
      // one, and the adapter still has to bind the tab to it.
      openProject: async (targetId, projectId) => {
        await adapter.openProject(targetId, projectId);
      },
      sessionExists: async (sessionId) => {
        // Unpinned on purpose: the owning project was just opened, so the
        // displayed adapter is that machine's. Authoritative, so null is "gone"
        // and a host that cannot answer rejects instead.
        return await answerWithin(
          adapter.ade.sessions.get(sessionId, undefined, { authoritative: true }).then((detail) => detail != null),
        );
      },
      laneExists: async (laneId) => {
        return await answerWithin(
          adapter.ade.lanes.list({ includeArchived: true, includeStatus: false }).then((lanes) => {
            // A project always has its primary lane; an empty list is a read
            // that fell back, not an answer.
            if (!Array.isArray(lanes) || lanes.length === 0) return null;
            return lanes.some((lane) => lane.id === laneId);
          }),
        );
      },
      onStage: (stage) => onStage(ownedLinkStageText(stage)),
    });
  }, [accountClient, connectMachineEntry, currentMachines, sessionManager]);

  /** Filled once `retryOwnedLink` exists; the adapter is built before it is. */
  const openOwnedDeeplinkRef = useRef<(url: string) => Promise<boolean>>(async () => false);

  const reconnectLastActiveMachine = useCallback(async () => {
    const machineKey = sessionManager.getLastActiveMachineKey();
    if (!machineKey) return;
    const machine = mergeWebMachines({
      accountMachines: accountRef.current.machines,
      snapshot: sessionManager.getSnapshot(),
      relayBaseUrls: accountClient.getRelayBaseUrls(),
    }).find((entry) => entry.key === machineKey);
    if (!machine || machine.session) return;
    try {
      await connectMachineEntry(machine);
    } catch {
      // The welcome surface still lists this machine's cached projects, and
      // opening one dials it again with the failure in view.
    }
  }, [accountClient, connectMachineEntry, sessionManager]);

  const installFederatedAdapter = useCallback(async (
    snapshot: BrowserAccountSnapshot,
    options: { restore?: boolean } = {},
  ): Promise<{
    adapter: FederatedWebAdapter;
    restored: "project" | "chats" | null;
  }> => {
    const accountKey = accountWorkspaceKey(snapshot);
    const existing = federatedAdapterRef.current;
    if (existing && federatedAccountKeyRef.current === accountKey) {
      return { adapter: existing, restored: null };
    }

    const generation = ++federatedAdapterGenerationRef.current;
    federatedAdapterDisposeRef.current();
    federatedAdapterDisposeRef.current = () => {};
    federatedAdapterRef.current?.dispose();
    federatedAdapterRef.current = null;
    federatedAccountKeyRef.current = null;
    setFederatedAdapter(null);

    const adapter = await loadFederatedAdapter(
      sessionManager,
      accountClient,
      accountKey,
      client,
      (url) => openOwnedDeeplinkRef.current(url),
    );
    if (federatedAdapterGenerationRef.current !== generation) {
      adapter.dispose();
      throw new Error("The browser account changed while restoring its workspace.");
    }

    federatedAdapterRef.current = adapter;
    federatedAccountKeyRef.current = accountKey;
    federatedAdapterDisposeRef.current = adapter.subscribeActiveAdapter(() => {
      setActiveAdapterGeneration((current) => current + 1);
    });
    setFederatedAdapter(adapter);
    setWorkspaceGeneration((current) => current + 1);
    window.ade = adapter.ade;
    // A link owned by another machine or project skips the restore: dialing the
    // last machine and reopening its project would only be undone.
    const restored = options.restore === false ? null : await adapter.restore();
    return { adapter, restored };
  }, [accountClient, client, sessionManager]);

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
          await installFederatedAdapter(result.snapshot);
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
  }, [
    accountClient,
    applyAccountPrivacy,
    installFederatedAdapter,
    relayAccess,
    sessionManager,
  ]);

  const displayedTargetId = federatedAdapter?.getDisplayedTargetId() ?? null;
  const activeLifecycleClient = displayedTargetId
    ? sessionManager.getClient(displayedTargetId)
    : null;
  useEffect(() => {
    if (!activeLifecycleClient) return;
    return installSessionLifecycleChrome(activeLifecycleClient);
  }, [activeLifecycleClient, displayedTargetId]);

  const retryDirectory = useCallback(async () => {
    setDirectoryLoading(true);
    try {
      const snapshot = await accountClient.loadMachines();
      setAccount(snapshot);
      const visible = await applyAccountPrivacy(snapshot);
      sessionManager.replaceEnvironments(visible);
      await installFederatedAdapter(snapshot);
    } finally {
      setDirectoryLoading(false);
    }
  }, [accountClient, applyAccountPrivacy, installFederatedAdapter, sessionManager]);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      if (LEGACY_PATHS.has(window.location.pathname)) {
        window.history.replaceState(null, "", "/");
      }
      const path = window.location.pathname;
      const linkInUrl = path === "/open" || isAppRoute(path);
      // A link in this URL replaces any stored one. A stored link keeps its
      // own age, so revisiting ADE Web does not keep an abandoned link alive.
      const pendingTarget = path === "/open"
        ? parseOpenTarget(window.location.search)
        : isAppRoute(path)
          ? parseWebPath(`${path}${window.location.search}`)
          : readPendingTarget();
      pendingTargetRef.current = pendingTarget;
      if (linkInUrl) stashPendingTarget(pendingTarget);

      const wasCallback = path === "/account/callback";
      if (!wasCallback) {
        // A stored session means the signed-in workspace is coming: start its
        // download now, alongside the session restore, instead of after it.
        void accountClient.hasPersistedSession().then((restorable) => {
          if (restorable && !disposed) preloadWorkspaceModules();
        });
      }
      const snapshot = await accountClient.bootstrap();
      if (disposed) return;
      setAccount(snapshot);
      // A callback that lands signed-out means the sign-in genuinely failed.
      // Without this the user is dropped on the gate with no explanation.
      if (wasCallback && !browserAccountIsSignedIn(snapshot.state) && snapshot.message) {
        setWorkspaceNotice(snapshot.message);
      }
      setPhase({ kind: "booting", message: "Opening your projects…" });

      const environments = await applyAccountPrivacy(snapshot);
      if (disposed) return;
      sessionManager.replaceEnvironments(environments);
      sessionManager.setRelayAccess(
        relayAccessFromAccount(snapshot, () => accountClient.getAccessToken()),
      );

      if (!browserAccountIsSignedIn(snapshot.state)) {
        // The sign-in card needs only the account namespace. The workspace router
        // and the last-machine reconnect wait for a session, so a signed-out
        // visitor downloads neither. A pending deep link stays stashed for after
        // sign-in.
        // The sign-in card lives in its own chunk, imported here so a failed
        // download lands on the error screen with Retry instead of a blank page.
        const { WebSignInScreen } = await import("../../components/onboarding/WebSignInGate");
        if (disposed) return;
        Object.assign(window.ade, { account: createAccountNamespace(accountClient) });
        window.history.replaceState(null, "", WELCOME_PATH);
        setPhase({ kind: "signed-out", SignIn: WebSignInScreen });
        return;
      }

      const linkTarget = pendingTargetRef.current ?? readPendingTarget();
      const ownedLinkTarget = ownershipOfTarget(linkTarget) ? linkTarget : null;
      const installed = await installFederatedAdapter(snapshot, { restore: !ownedLinkTarget });
      if (disposed) return;
      let restored = installed.restored;
      let initialPath: string;
      if (ownedLinkTarget) {
        // A chat, lane or PR link names its machine and project: go there, not
        // to whatever this browser had open last.
        const runId = ++ownedLinkRunRef.current;
        // Each step stays on screen, ticked, so a slow one is plain to see.
        const steps: string[] = [];
        const result = await resolveOwnedTarget(ownedLinkTarget, installed.adapter, (message) => {
          if (disposed || ownedLinkRunRef.current !== runId) return;
          const done = [...steps];
          steps.push(finishedStepText(message));
          setPhase({ kind: "booting", title: "Opening your link", message, done });
        });
        if (disposed) return;
        const landing = result ? settleOwnedLink(result) : null;
        if (landing) {
          initialPath = landing;
        } else {
          // Say what went wrong over where the person was, and keep the link
          // pending: opening its project from the welcome page still lands on it.
          restored = await installed.adapter.restore();
          if (disposed) return;
          initialPath = WELCOME_PATH;
        }
      } else {
        const restoredTarget = pendingTargetRef.current ?? readPendingTarget();
        initialPath = restored
          ? restoredTarget
            ? targetToWebPath(restoredTarget)
            : isAppRoute(path)
              ? `${path}${window.location.search}`
              : WELCOME_PATH
          : WELCOME_PATH;
        if (restored) clearPendingTarget();
      }
      window.history.replaceState(null, "", initialPath);
      const AppRoot = await loadAppRoot();
      if (!disposed) setPhase({ kind: "ready", AppRoot });
      // Nothing to restore means the welcome surface is what the user sees, and
      // it has already painted from the persisted catalogs. Bringing the last
      // machine back is a background refresh, never a gate on first paint.
      if (!restored && !disposed) void reconnectLastActiveMachine();
    })().catch((error) => {
      if (disposed) return;
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      disposed = true;
      federatedAdapterGenerationRef.current += 1;
      federatedAdapterDisposeRef.current();
      federatedAdapterDisposeRef.current = () => {};
      federatedAdapterRef.current?.dispose();
      federatedAdapterRef.current = null;
      federatedAccountKeyRef.current = null;
      sessionManager.dispose();
    };
  }, [
    accountClient,
    applyAccountPrivacy,
    clearPendingTarget,
    installFederatedAdapter,
    reconnectLastActiveMachine,
    resolveOwnedTarget,
    sessionManager,
    settleOwnedLink,
  ]);

  /**
   * Whether the project tab just opened is where a pending link belongs. A link
   * without ownership opens in any project, as it always has; an owned one only
   * in its own, so picking another project on the welcome page leaves it waiting.
   */
  const pendingTargetBelongsToActiveProject = useCallback((target: DeeplinkTarget): boolean => {
    const ownership = ownershipOfTarget(target);
    if (!ownership) return true;
    const binding = federatedAdapterRef.current?.getActiveBinding() ?? null;
    if (!binding) return false;
    const machine = currentMachines().find((entry) => (
      entry.session?.targetId === binding.targetId || entry.environment?.envId === binding.targetId
    ));
    if (machine?.accountMachine?.machineKey !== ownership.accountMachineKey) return false;
    const match = matchOwnedProject(sessionManager.getSession(binding.targetId)?.projects ?? [], ownership, target);
    return match.kind === "found" && match.project.id === binding.projectId;
  }, [currentMachines, sessionManager]);

  const dismissOwnedLink = useCallback(() => {
    ownedLinkRunRef.current += 1;
    setOwnedLink(null);
    clearPendingTarget();
  }, [clearPendingTarget]);

  /**
   * Try the pending link again with the app up: progress and failure ride the
   * app banner, and success moves the mounted router to the link's route.
   */
  const retryOwnedLink = useCallback(() => {
    const target = pendingTargetRef.current ?? readPendingTarget();
    const adapter = federatedAdapterRef.current;
    if (!target || !adapter || !ownershipOfTarget(target)) {
      setOwnedLink(null);
      return;
    }
    const runId = ++ownedLinkRunRef.current;
    const current = () => ownedLinkRunRef.current === runId;
    setOwnedLink({ status: "resolving", message: "Checking your computers…" });
    void (async () => {
      try {
        // The machine may have come online, or joined the account, since the
        // last try: read the directory again before deciding.
        const snapshot = await accountClient.loadMachines();
        if (!current()) return;
        setAccount(snapshot);
        sessionManager.setRelayAccess(
          relayAccessFromAccount(snapshot, () => accountClient.getAccessToken()),
        );
      } catch {
        // The cached directory still answers; a stale one is retried next time.
      }
      const result = await resolveOwnedTarget(target, adapter, (message) => {
        if (current()) setOwnedLink({ status: "resolving", message });
      });
      if (!current() || !result) return;
      const landing = settleOwnedLink(result);
      if (landing) navigateMountedApp(landing);
    })().catch((error) => {
      if (!current()) return;
      setOwnedLink({
        status: "failed",
        failure: {
          kind: "open-failed",
          title: "Couldn't open this link.",
          detail: error instanceof Error ? error.message : String(error),
          retryable: true,
          offerComputers: true,
        },
      });
    });
  }, [accountClient, resolveOwnedTarget, sessionManager, settleOwnedLink]);

  // A link inside the app (a moved chat's "Open on …") takes the same route as
  // one the visitor arrived with; progress and failure ride the app banner.
  useEffect(() => {
    openOwnedDeeplinkRef.current = async (url) => {
      const parsed = parseDeeplink(url);
      if (!parsed.ok || !ownershipOfTarget(parsed.target)) return false;
      pendingTargetRef.current = parsed.target;
      stashPendingTarget(parsed.target);
      retryOwnedLink();
      return true;
    };
  }, [retryOwnedLink]);

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
        const target = pendingTargetRef.current ?? readPendingTarget();
        if (!target) return null;
        if (!pendingTargetBelongsToActiveProject(target)) return null;
        clearPendingTarget();
        setOwnedLink(null);
        return targetToWebPath(target);
      },
      ownedLink,
      retryOwnedLink,
      dismissOwnedLink,
      signIn,
      async signOut() {
        const snapshot = await accountClient.signOut();
        setAccount(snapshot);
        for (const session of sessionManager.getSnapshot().sessions) {
          await sessionManager.park(session.targetId);
        }
        const visible = await applyAccountPrivacy(snapshot);
        sessionManager.replaceEnvironments(visible);
        await installFederatedAdapter(snapshot);
      },
      retryDirectory,
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
      connectMachineEntry,
      forgetMachineCatalog(machineKeys) {
        for (const machineKey of machineKeys) sessionManager.forgetCatalog(machineKey);
      },
      async renameMachine(machineKey, customName) {
        await accountClient.renameMachine(machineKey, customName);
        setAccount(accountClient.getSnapshot());
      },
      async removeAccountMachine(machineKey) {
        const entry = mergeWebMachines({
          accountMachines: accountRef.current.machines,
          snapshot: sessionManager.getSnapshot(),
          relayBaseUrls: accountClient.getRelayBaseUrls(),
        }).find((machine) => machine.accountMachine?.machineKey === machineKey) ?? null;
        let removalError: Error | null = null;
        try {
          await accountClient.removeMachine(machineKey);
        } catch (cause) {
          removalError = cause instanceof Error ? cause : new Error(String(cause));
          if (accountClient.getSnapshot().machines.some((machine) => machine.machineKey === machineKey)) {
            throw removalError;
          }
        }
        const snapshot = accountClient.getSnapshot();
        setAccount(snapshot);
        if (entry?.environment) {
          await adapter.forgetEnvironment(entry.environment.envId);
        }
        if (entry) {
          for (const catalogKey of webMachineCatalogKeys(entry)) {
            sessionManager.forgetCatalog(catalogKey);
          }
        }
        const visible = await applyAccountPrivacy(snapshot);
        sessionManager.replaceEnvironments(visible);
        if (removalError) throw removalError;
      },
      async forgetEnvironment(targetId) {
        await adapter.forgetEnvironment(targetId);
        await refreshVisibleEnvironments();
      },
    };
  }, [
    account,
    accountClient,
    // Not read here on purpose: consumers call imperative getters on `adapter`
    // (`getDisplayedTargetId`, `getActiveBinding`). The adapter object is stable
    // across tab switches, so without a revision in this dependency list the
    // context value would keep its identity and memoized consumers would go on
    // showing the previous tab. The full remount used to hide that.
    activeAdapterGeneration,
    applyAccountPrivacy,
    connectMachineEntry,
    connectingMachineKey,
    directoryLoading,
    clearPendingTarget,
    federatedAdapter,
    dismissOwnedLink,
    installFederatedAdapter,
    ownedLink,
    pendingTargetBelongsToActiveProject,
    refreshVisibleEnvironments,
    retryDirectory,
    retryOwnedLink,
    sessionManager,
    signIn,
    workspaceNotice,
    workspaceSnapshot,
  ]);

  switch (phase.kind) {
    case "signing-in":
      return <ProgressScreen title="Signing in…" message="Completing secure sign-in…" />;
    case "booting":
      return <ProgressScreen title={phase.title ?? "Starting ADE"} message={phase.message} done={phase.done} />;
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
    case "signed-out": {
      const SignIn = phase.SignIn;
      return <SignIn />;
    }
    case "ready": {
      if (!workspaceContext) {
        return <ProgressScreen title="Starting ADE" message="Preparing your workspace…" />;
      }
      const AppRoot = phase.AppRoot;
      return (
        <WebWorkspaceProvider value={workspaceContext}>
          <AppRoot key={workspaceGeneration} />
        </WebWorkspaceProvider>
      );
    }
  }
}

/**
 * How long an owned link waits to learn whether its chat or lane still exists.
 * The check only decides between "open it" and "it is gone"; with no answer
 * the link opens anyway, so a project that is still starting on the computer
 * must not hold the page for the full request timeout.
 */
const OWNED_LINK_CHECK_MS = 6_000;

/** The check's answer, or null (could not say) when it takes too long. */
function answerWithin(check: Promise<boolean | null>): Promise<boolean | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn("[ade-web] the link's chat or lane check got no answer in time; opening the link anyway");
      resolve(null);
    }, OWNED_LINK_CHECK_MS);
    check.then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** "Connecting to Studio…" once it is over: "Connecting to Studio". */
function finishedStepText(message: string): string {
  return message.replace(/…$/, "");
}

function ProgressScreen({ title, message, done = [] }: { title: string; message: string; done?: readonly string[] }) {
  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontFamily: SANS_FONT,
    fontSize: 13,
    lineHeight: 1.4,
  };
  return (
    <ScreenShell title={title}>
      <div role="status" aria-live="polite" style={{ display: "grid", gap: 12 }}>
        {done.map((step, index) => (
          // The list only grows, so the position is a stable key.
          <div key={index} style={{ ...row, color: COLORS.textMuted }}>
            <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
              <path d="M3 7.4l2.6 2.6L11 4.4" stroke={COLORS.success} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {step}
          </div>
        ))}
        <div style={{ ...row, color: COLORS.textPrimary }}>
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 14,
              height: 14,
              boxSizing: "border-box",
              borderRadius: "50%",
              border: "2px solid color-mix(in srgb, var(--color-fg) 20%, transparent)",
              borderTopColor: "var(--color-accent)",
              animation: "ade-web-spin 0.8s steps(24) infinite",
            }}
          />
          {message}
        </div>
        <style>{"@keyframes ade-web-spin { to { transform: rotate(360deg); } }"}</style>
      </div>
    </ScreenShell>
  );
}
