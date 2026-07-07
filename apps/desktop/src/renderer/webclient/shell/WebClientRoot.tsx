import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectInfo } from "../../../shared/types";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type { DeeplinkTarget } from "../../../shared/deeplinks";
import {
  AdeSyncClient,
  type AdeSyncClientStatus,
  type WebClientEnvironmentRecord,
} from "../sync";
import { parseOpenTarget, parseWebPath, targetToWebPath } from "./webRoutes";
import { ScreenShell } from "./ScreenShell";
import { Welcome } from "./Welcome";
import { PairFlow } from "./PairFlow";
import { ProjectPicker } from "./ProjectPicker";
import { WebShell } from "./WebShell";
import { COLORS, SANS_FONT, primaryButton } from "./shellTokens";

type AdeWebAdapter = {
  ade: Window["ade"];
  bindProject: (project: ProjectInfo | null) => void;
  dispose: () => void;
};

async function loadAdapter(client: AdeSyncClient): Promise<AdeWebAdapter> {
  const module = await import("../adapter/index");
  return module.createAdeWebAdapter(client);
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
const APP_ROUTE_ROOTS = [
  "/work", "/lanes", "/files", "/prs", "/review", "/history",
  "/automations", "/cto", "/settings", "/graph", "/project",
];

function isAppRoute(pathname: string): boolean {
  return APP_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
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
  | { kind: "welcome"; note?: string }
  | { kind: "pairing"; reloadOnSuccess: boolean }
  | { kind: "connecting"; name: string }
  | { kind: "project-picker"; projects: SyncMobileProjectSummary[] }
  | { kind: "ready"; AppRoot: React.ComponentType }
  | { kind: "error"; message: string; canRetry: boolean };

export function WebClientRoot({ client }: { client: AdeSyncClient }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [status, setStatus] = useState<AdeSyncClientStatus>(() => client.getStatus());
  const [environments, setEnvironments] = useState<WebClientEnvironmentRecord[]>([]);
  const [catalog, setCatalog] = useState<SyncMobileProjectSummary[]>([]);

  const adapterRef = useRef<AdeWebAdapter | null>(null);
  const stashedTargetRef = useRef<DeeplinkTarget | null>(null);
  const bootedRef = useRef(false);
  const fatalRebootRef = useRef(false);
  const phaseIsReadyRef = useRef(false);
  phaseIsReadyRef.current = phase.kind === "ready";

  const refreshEnvironments = useCallback(async () => {
    const list = await client.listEnvironments();
    setEnvironments(list);
    return list;
  }, [client]);

  // Bring the connected machine's catalog + selected project online, then mount
  // the shared App with the sync-backed adapter installed on window.ade.
  const enterProject = useCallback(async (project: SyncMobileProjectSummary) => {
    if (project.id !== client.getStatus().activeProjectId) {
      await client.switchProject(project.id);
    }
    if (!adapterRef.current) {
      adapterRef.current = await loadAdapter(client);
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

  const afterConnect = useCallback(async () => {
    const activeEnv = (await client.listEnvironments()).find((environment) => environment.envId === client.getStatus().selectedEnvId) ?? null;
    let projects: SyncMobileProjectSummary[] = [];
    try {
      projects = (await client.getProjectCatalog()).projects;
    } catch {
      projects = [];
    }
    setCatalog(projects);

    const activeProjectId = client.getStatus().activeProjectId;
    const chosen =
      projects.find((project) => project.id === activeEnv?.activeProjectId && (project.isAvailable || project.isOpen))
      ?? projects.find((project) => project.id === activeProjectId)
      ?? projects.find((project) => project.isOpen)
      ?? (projects.length === 1 ? projects[0] : null);

    if (chosen) {
      await enterProject(chosen);
    } else {
      setPhase({ kind: "project-picker", projects });
    }
  }, [client, enterProject]);

  const connectTo = useCallback(async (environment: WebClientEnvironmentRecord) => {
    setPhase({ kind: "connecting", name: environment.machineName });
    try {
      await client.connect(environment.envId);
      await afterConnect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPhase({ kind: "error", message, canRetry: true });
    }
  }, [client, afterConnect]);

  // ---- Boot sequence ------------------------------------------------------
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void (async () => {
      const path = window.location.pathname;
      if (path === "/pair") {
        setPhase({ kind: "pairing", reloadOnSuccess: false });
        return;
      }
      if (path === "/open") {
        stashedTargetRef.current = parseOpenTarget(window.location.search);
        stashTarget(stashedTargetRef.current);
      } else if (isAppRoute(path)) {
        stashedTargetRef.current = parseWebPath(`${path}${window.location.search}`);
      } else {
        stashedTargetRef.current = readStashedTarget();
      }

      const list = await refreshEnvironments();
      if (list.length === 0) {
        setPhase({ kind: "welcome" });
        return;
      }
      await connectTo(list[0]);
    })().catch((error) => {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error), canRetry: false });
    });
  }, [connectTo, refreshEnvironments]);

  // ---- Live status subscription ------------------------------------------
  useEffect(() => {
    return client.subscribe((next) => {
      setStatus(next);
      // Pairing revoked / auth failed and attributed to this host: the client
      // has already dropped the environment. Cold-reboot to reconnect to any
      // remaining machine, or land on the welcome screen.
      if (next.state === "auth_failed" && !fatalRebootRef.current && phaseIsReadyRef.current) {
        fatalRebootRef.current = true;
        window.location.assign("/");
      }
    });
  }, [client]);

  useEffect(() => {
    return client.onProjectCatalog((payload) => setCatalog(payload.projects));
  }, [client]);

  // ---- Chrome callbacks ---------------------------------------------------
  const onSwitchEnv = useCallback((environment: WebClientEnvironmentRecord) => {
    // Machine switches touch the whole graph (new catalog, new adapter binding);
    // persist the selection and cold-reboot for a clean connect.
    void client.switchEnvironment(environment.envId).catch(() => {});
    window.location.assign("/");
  }, [client]);

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

  const onPairNew = useCallback(() => setPhase({ kind: "pairing", reloadOnSuccess: true }), []);

  // ---- Render -------------------------------------------------------------
  switch (phase.kind) {
    case "loading":
      return <Connecting name={null} />;
    case "connecting":
      return <Connecting name={phase.name} />;
    case "welcome":
      return <Welcome onPair={() => setPhase({ kind: "pairing", reloadOnSuccess: false })} />;
    case "pairing":
      return (
        <PairFlow
          client={client}
          hash={window.location.hash}
          onBack={environments.length > 0 ? () => setPhase({ kind: "loading" }) : undefined}
          onPaired={(environment) => {
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
    case "project-picker":
      return (
        <ProjectPicker
          projects={phase.projects}
          machineName={status.hostName}
          onPick={(project) => {
            setPhase({ kind: "connecting", name: project.displayName });
            void enterProject(project).catch((error) => {
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
              onClick={() => setPhase({ kind: "welcome" })}
            >
              Pair a machine
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
          onSwitchEnv={onSwitchEnv}
          onPairNew={onPairNew}
          onForgetEnv={onForgetEnv}
          onSwitchProject={onSwitchProject}
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
      subtitle="Establishing a secure connection to your machine…"
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
