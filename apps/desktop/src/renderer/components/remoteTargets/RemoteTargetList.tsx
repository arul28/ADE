import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  CaretDown,
  CaretUp,
  CheckCircle,
  DesktopTower,
  PlugsConnected,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { extractError } from "../../lib/format";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import type {
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeConnectResult,
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeSshHostKeyTrustStatus,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTargetRoute,
  RemoteRuntimeTargetRouteSource,
} from "../../../shared/types";
import {
  RemoteTargetForm,
  type RemoteTargetFormPrefill,
} from "./RemoteTargetForm";

type RemoteTargetListProps = {
  onConnected?: (result: RemoteRuntimeConnectResult) => void;
  onDisconnectRequested?: (
    target: RemoteRuntimeTarget,
  ) => boolean | Promise<boolean>;
  onRemoveRequested?: (
    target: RemoteRuntimeTarget,
  ) => boolean | Promise<boolean>;
};

type ConnectTargetOptions = {
  skipHostKeyTrustCheck?: boolean;
};

const panelStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  padding: 0,
};

const machineRowStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "12px 14px",
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(255,255,255,0.02)",
};

const inlineDetailStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  marginTop: -4,
  padding: 12,
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(0,0,0,0.16)",
};

const helperTextStyle: CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.45,
};

function formatLastSeen(value: number | null): string {
  if (!value) return "Never connected";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Last connection unknown";
  return `Last connected ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function discoveredRuntimeLabel(
  machine: RemoteRuntimeDiscoveredMachine,
): string {
  const kind = (machine.runtimeKind ?? "").toLowerCase();
  let label: string;
  switch (kind) {
    case "tailscale-peer":
      label = "Tailscale SSH target";
      break;
    case "tailscale-peer-offline":
      label = "Tailscale SSH target offline";
      break;
    case "daemon":
    case "headless":
      label = "Background ADE";
      break;
    case "desktop":
    case "desktop-embedded":
      label = "ADE app";
      break;
    default:
      label = "ADE service";
  }
  return machine.runtimeVersion ? `${label} ${machine.runtimeVersion}` : label;
}

function discoveredProjectLabel(
  machine: RemoteRuntimeDiscoveredMachine,
): string {
  if ((machine.runtimeKind ?? "").startsWith("tailscale-peer"))
    return "Not saved yet";
  const count = machine.projectCount ?? machine.projectIds.length;
  if (count <= 0) return "No projects advertised";
  return `${count} project${count === 1 ? "" : "s"} advertised`;
}

function discoveredRoute(
  machine: RemoteRuntimeDiscoveredMachine,
): string | null {
  return (
    machine.tailscaleAddress ??
    machine.primaryRoute ??
    machine.hostName ??
    machine.addresses[0] ??
    null
  );
}

function isTailscaleRoute(hostname: string | null | undefined): boolean {
  const normalized = hostname?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  if (normalized.endsWith(".ts.net")) return true;
  const match = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!match) return false;
  const second = Number.parseInt(match[1] ?? "", 10);
  return second >= 64 && second <= 127;
}

function normalizeRouteHost(hostname: string | null | undefined): string {
  return hostname?.trim().toLowerCase().replace(/\.$/, "") ?? "";
}

function normalizeRoutePort(port: number | null | undefined): number {
  return port ?? 22;
}

function routeIdentity(hostname: string | null | undefined, port: number | null | undefined): string | null {
  const host = normalizeRouteHost(hostname);
  if (!host) return null;
  return `${host}:${normalizeRoutePort(port)}`;
}

function discoveredRouteSource(
  machine: RemoteRuntimeDiscoveredMachine,
  hostname: string,
): RemoteRuntimeTargetRouteSource {
  if (
    (machine.runtimeKind ?? "").startsWith("tailscale-peer") ||
    hostname === machine.tailscaleAddress ||
    isTailscaleRoute(hostname)
  ) {
    return "tailscale";
  }
  return "bonjour";
}

function discoveredSshRoutes(
  machine: RemoteRuntimeDiscoveredMachine,
): RemoteRuntimeTargetRoute[] {
  const hostnames = [
    machine.tailscaleAddress,
    machine.primaryRoute,
    machine.hostName,
    ...machine.addresses,
  ];
  const routes: RemoteRuntimeTargetRoute[] = [];
  const seen = new Set<string>();
  for (const value of hostnames) {
    const hostname = value?.trim().replace(/\.$/, "");
    if (!hostname) continue;
    const key = hostname.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({
      hostname,
      port: null,
      source: discoveredRouteSource(machine, hostname),
      lastSucceededAt: null,
    });
  }
  return routes;
}

function discoveredTargetInput(
  machine: RemoteRuntimeDiscoveredMachine,
): RemoteRuntimeTargetInput | null {
  const route = discoveredRoute(machine);
  if (!route) return null;
  return {
    name: machine.machineName,
    hostname: route.replace(/\.$/, ""),
    sshUser: null,
    port: null,
    sshKeyPath: null,
    routes: discoveredSshRoutes(machine),
  };
}

function targetFormPrefill(
  target: RemoteRuntimeTarget,
): RemoteTargetFormPrefill {
  return {
    key: `target:${target.id}:${target.lastConnectedAt ?? "never"}:${target.sshUser ?? ""}:${target.port ?? ""}:${target.sshKeyPath ?? ""}`,
    targetId: target.id,
    name: target.name,
    hostname: target.hostname,
    sshUser: target.sshUser,
    port: target.port,
    sshKeyPath: target.sshKeyPath,
    routes: target.routes ?? null,
  };
}

function targetConnectionLabel(target: RemoteRuntimeTarget): string {
  const userPrefix = target.sshUser ? `${target.sshUser}@` : "";
  const portSuffix = target.port ? `:${target.port}` : "";
  let defaultHint = "";
  if (!target.sshUser && !target.port) {
    defaultHint = " (SSH defaults)";
  } else if (!target.sshUser) {
    defaultHint = " (default SSH user)";
  } else if (!target.port) {
    defaultHint = " (default port)";
  }
  const targetHostKey = target.hostname.toLowerCase().replace(/\.$/, "");
  const fallbackRoutes = (target.routes ?? []).filter(
    (route) =>
      route.hostname.toLowerCase().replace(/\.$/, "") !== targetHostKey ||
      route.port !== target.port,
  ).length;
  const fallbackHint =
    fallbackRoutes > 0
      ? ` + ${fallbackRoutes} route${fallbackRoutes === 1 ? "" : "s"}`
      : "";
  return `${userPrefix}${target.hostname}${portSuffix}${defaultHint}${fallbackHint}`;
}

function targetRouteIdentities(target: RemoteRuntimeTarget): Set<string> {
  const identities = new Set<string>();
  const primary = routeIdentity(target.hostname, target.port);
  if (primary) identities.add(primary);
  for (const route of target.routes ?? []) {
    const identity = routeIdentity(route.hostname, route.port ?? target.port);
    if (identity) identities.add(identity);
  }
  return identities;
}

function discoveredMachineRouteIdentities(
  machine: RemoteRuntimeDiscoveredMachine,
): Set<string> {
  const identities = new Set<string>();
  for (const route of discoveredSshRoutes(machine)) {
    const identity = routeIdentity(route.hostname, route.port);
    if (identity) identities.add(identity);
  }
  return identities;
}

function discoveredMachineMatchesSavedTarget(
  machine: RemoteRuntimeDiscoveredMachine,
  targets: RemoteRuntimeTarget[],
): boolean {
  const discovered = discoveredMachineRouteIdentities(machine);
  if (discovered.size === 0) return false;
  return targets.some((target) => {
    const saved = targetRouteIdentities(target);
    for (const identity of discovered) {
      if (saved.has(identity)) return true;
    }
    return false;
  });
}

function connectionStateLabel(
  connection: RemoteRuntimeConnectionStatus | null,
  connected: RemoteRuntimeConnectResult | null,
): string {
  if (connection?.state === "connected" || (!connection && connected))
    return "Connected";
  if (connection?.state === "connecting") return "Connecting";
  if (connection?.state === "error") return "Connection failed";
  return "Not connected";
}

function formatRemoteTargetError(error: unknown): string {
  const message = extractError(error)
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();

  if (/^(?:read\s+)?ECONNRESET$/i.test(message)) {
    return "SSH server closed the connection before ADE could finish the SSH handshake. Check that Remote Login/sshd is enabled on the remote machine and try again.";
  }

  if (/permission denied|all configured authentication methods failed/i.test(message)) {
    return "SSH authentication failed. Check the SSH user, key path, and that this key is allowed on the remote machine.";
  }

  if (/host denied|verification failed|host key verification/i.test(message)) {
    return "SSH host-key verification failed. Check that this is the right machine, then update the saved SSH host key or trust the new key when ADE prompts.";
  }

  if (/timed out.*handshake|handshake.*timed out|connect.*timed out/i.test(message)) {
    return "SSH did not finish connecting. Check that the machine is awake, reachable on Tailscale or LAN, and Remote Login is enabled.";
  }

  if (/ECONNREFUSED/i.test(message)) {
    return "The machine refused the SSH connection. Check the port and make sure Remote Login/sshd is running.";
  }

  if (/ENOTFOUND|could not resolve hostname|name or service not known/i.test(message)) {
    return "ADE could not resolve that host. Check the hostname, or use the Tailscale 100.x address from discovery.";
  }

  return message || "Remote connection failed.";
}

export function RemoteTargetList({
  onConnected,
  onDisconnectRequested,
  onRemoveRequested,
}: RemoteTargetListProps) {
  const [targets, setTargets] = useState<RemoteRuntimeTarget[]>([]);
  const [connectionSnapshot, setConnectionSnapshot] =
    useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [discoveredMachines, setDiscoveredMachines] = useState<
    RemoteRuntimeDiscoveredMachine[]
  >([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState<RemoteRuntimeConnectResult | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadingDiscovered, setLoadingDiscovered] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [trustingHostKey, setTrustingHostKey] = useState(false);
  const [formPrefill, setFormPrefill] =
    useState<RemoteTargetFormPrefill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [hostKeyTrust, setHostKeyTrust] =
    useState<RemoteRuntimeSshHostKeyTrustStatus | null>(null);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? null,
    [selectedId, targets],
  );
  const selectedConnection = useMemo(
    () =>
      connectionSnapshot?.connections.find(
        (entry) => entry.target.id === selectedId,
      ) ?? null,
    [connectionSnapshot, selectedId],
  );
  const selectedConnectionError =
    selectedConnection?.state === "error" && selectedConnection.lastError
      ? formatRemoteTargetError(selectedConnection.lastError)
      : null;
  const selectedCompatibilityWarnings =
    selectedConnection?.compatibilityWarnings ??
    (connected?.target.id === selectedId ? connected.compatibilityWarnings : []) ??
    [];
  const selectedHostKeyTrust =
    selectedTarget && hostKeyTrust?.targetId === selectedTarget.id
      ? hostKeyTrust
      : null;
  const visibleDiscoveredMachines = useMemo(
    () =>
      discoveredMachines.filter(
        (machine) => !discoveredMachineMatchesSavedTarget(machine, targets),
      ),
    [discoveredMachines, targets],
  );
  const manualAddOpen = formPrefill?.key === "manual:add";
  const activeFormKey = formPrefill?.key ?? null;

  const loadTargets = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = window.ade.remoteRuntime.getConnectionSnapshot
        ? await window.ade.remoteRuntime.getConnectionSnapshot()
        : null;
      const next = snapshot
        ? snapshot.connections.map((entry) => entry.target)
        : await window.ade.remoteRuntime.listTargets();
      if (snapshot) setConnectionSnapshot(snapshot);
      setTargets(next);
      setSelectedId((current) => current ?? next[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(formatRemoteTargetError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  useEffect(() => {
    if (!window.ade.remoteRuntime.onConnectionSnapshotChanged) return;
    const unsubscribe = window.ade.remoteRuntime.onConnectionSnapshotChanged(
      (snapshot) => {
        setConnectionSnapshot(snapshot);
        setTargets(snapshot.connections.map((entry) => entry.target));
        setSelectedId(
          (current) => current ?? snapshot.connections[0]?.target.id ?? null,
        );
      },
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!selectedConnection) return;
    if (selectedConnection.state !== "connected") {
      setConnected((current) =>
        current?.target.id === selectedConnection.target.id ? null : current,
      );
      return;
    }
    setConnected({
      target: selectedConnection.target,
      arch:
        selectedConnection.arch ??
        selectedConnection.target.lastSeenArch ??
        "unknown",
      version:
        selectedConnection.version ??
        selectedConnection.target.runtimeBinaryVersion,
      capabilities: selectedConnection.capabilities,
      compatibilityWarnings: selectedConnection.compatibilityWarnings,
      projects: selectedConnection.projects,
    });
  }, [selectedConnection]);

  const loadDiscoveredMachines = useCallback(async () => {
    setLoadingDiscovered(true);
    try {
      const next = await window.ade.remoteRuntime.listDiscoveredMachines();
      setDiscoveredMachines(next.machines);
      setDiscoveryError(
        next.diagnostics.length > 0
          ? next.diagnostics.map((entry) => entry.message).join(" ")
          : null,
      );
    } catch (err) {
      setDiscoveryError(extractError(err));
    } finally {
      setLoadingDiscovered(false);
    }
  }, []);

  useEffect(() => {
    void loadDiscoveredMachines();
  }, [loadDiscoveredMachines]);

  const openManualAddForm = useCallback(() => {
    setSelectedId(null);
    setFormPrefill({
      key: "manual:add",
      targetId: null,
      name: null,
      hostname: "",
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: null,
    });
    setError(null);
    setHostKeyTrust(null);
  }, []);

  const toggleDiscoveredForm = useCallback(
    (machine: RemoteRuntimeDiscoveredMachine) => {
      const key = `${machine.id}:${machine.lastSeenAt}`;
      setSelectedId(null);
      setError(null);
      setHostKeyTrust(null);
      setFormPrefill((current) =>
        current?.key === key
          ? null
          : {
              key,
              targetId: null,
              ...(discoveredTargetInput(machine) ?? {
                name: machine.machineName,
                hostname: "",
                sshUser: null,
                port: null,
                sshKeyPath: null,
                routes: discoveredSshRoutes(machine),
              }),
            },
      );
    },
    [],
  );

  const toggleEditForm = useCallback((target: RemoteRuntimeTarget) => {
    setSelectedId(target.id);
    setError(null);
    setHostKeyTrust(null);
    setFormPrefill((current) =>
      current?.targetId === target.id ? null : targetFormPrefill(target),
    );
  }, []);

  const ensureHostKeyTrust = useCallback(async (targetId: string) => {
    const status = await window.ade.remoteRuntime.getSshHostKeyTrust(targetId);
    if (status.state === "needs_trust" || status.state === "changed") {
      setHostKeyTrust(status);
      setError(null);
      return false;
    }
    setHostKeyTrust((current) =>
      current?.targetId === targetId ? null : current,
    );
    return true;
  }, []);

  const connectTarget = useCallback(
    async (targetId: string, options: ConnectTargetOptions = {}) => {
      setBusyId(targetId);
      setSelectedId(targetId);
      try {
        if (!options.skipHostKeyTrustCheck) {
          const trusted = await ensureHostKeyTrust(targetId);
          if (!trusted) return false;
        }
        const result = await window.ade.remoteRuntime.connect(targetId);
        setConnected(result);
        setTargets((current) =>
          current.map((target) =>
            target.id === result.target.id ? result.target : target,
          ),
        );
        setConnectionSnapshot((current) => {
          const fallbackConnections = targets.map((target) => ({
            target,
            state: "idle" as const,
            arch: target.lastSeenArch,
            version: target.runtimeBinaryVersion,
            projects: [],
            lastError: null,
            lastAttemptedAt: null,
            connectedAt: target.lastConnectedAt,
          }));
          const existing = current?.connections ?? fallbackConnections;
          const connections = existing.some(
            (entry) => entry.target.id === result.target.id,
          )
            ? existing.map((entry) =>
                entry.target.id === result.target.id
                  ? {
                      target: result.target,
                      state: "connected" as const,
                      arch: result.arch,
                      version: result.version,
                      capabilities: result.capabilities,
                      compatibilityWarnings: result.compatibilityWarnings,
                      projects: result.projects,
                      lastError: null,
                      lastAttemptedAt: Date.now(),
                      connectedAt: result.target.lastConnectedAt ?? Date.now(),
                    }
                  : entry,
              )
            : [
                ...existing,
                {
                  target: result.target,
                  state: "connected" as const,
                  arch: result.arch,
                  version: result.version,
                  capabilities: result.capabilities,
                  compatibilityWarnings: result.compatibilityWarnings,
                  projects: result.projects,
                  lastError: null,
                  lastAttemptedAt: Date.now(),
                  connectedAt: result.target.lastConnectedAt ?? Date.now(),
                },
              ];
          return {
            connections,
            connectedCount: connections.filter(
              (entry) => entry.state === "connected",
            ).length,
            updatedAt: Date.now(),
          };
        });
        setSelectedId(result.target.id);
        setHostKeyTrust(null);
        setError(null);
        onConnected?.(result);
        return true;
      } catch (err) {
        setError(formatRemoteTargetError(err));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [ensureHostKeyTrust, onConnected, targets],
  );

  const trustAndConnect = useCallback(async () => {
    if (!selectedHostKeyTrust || selectedHostKeyTrust.state !== "needs_trust")
      return;
    setTrustingHostKey(true);
    try {
      await window.ade.remoteRuntime.trustSshHostKey(
        selectedHostKeyTrust.targetId,
        selectedHostKeyTrust.fingerprintSha256,
      );
      setHostKeyTrust(null);
      await connectTarget(selectedHostKeyTrust.targetId, {
        skipHostKeyTrustCheck: true,
      });
    } catch (err) {
      setError(formatRemoteTargetError(err));
    } finally {
      setTrustingHostKey(false);
    }
  }, [connectTarget, selectedHostKeyTrust]);

  const saveTargetAndConnect = useCallback(
    async (
      input: RemoteRuntimeTargetInput,
      replacedTargetId: string | null = null,
    ) => {
      setSaving(true);
      try {
        const target = await window.ade.remoteRuntime.saveTarget(input);
        if (replacedTargetId && replacedTargetId !== target.id) {
          await window.ade.remoteRuntime.removeTarget(replacedTargetId);
        }
        setTargets((current) => [
          target,
          ...current.filter(
            (entry) => entry.id !== target.id && entry.id !== replacedTargetId,
          ),
        ]);
        setSelectedId(target.id);
        setError(null);
        const connectedOk = await connectTarget(target.id);
        if (connectedOk) setFormPrefill(null);
      } catch (err) {
        setError(formatRemoteTargetError(err));
      } finally {
        setSaving(false);
      }
    },
    [connectTarget],
  );

  const saveAndConnect = useCallback(
    async (input: RemoteRuntimeTargetInput) => {
      await saveTargetAndConnect(input, formPrefill?.targetId ?? null);
    },
    [formPrefill?.targetId, saveTargetAndConnect],
  );

  const connectDiscoveredMachine = useCallback(
    async (machine: RemoteRuntimeDiscoveredMachine) => {
      const input = discoveredTargetInput(machine);
      if (!input) return;
      setBusyId(machine.id);
      setSelectedId(null);
      setHostKeyTrust(null);
      setError(null);
      try {
        await saveTargetAndConnect(input);
      } finally {
        setBusyId(null);
      }
    },
    [saveTargetAndConnect],
  );

  const disconnectTarget = useCallback(async (targetId: string) => {
    const target = targets.find((entry) => entry.id === targetId) ?? null;
    if (target && onDisconnectRequested) {
      const shouldDisconnect = await onDisconnectRequested(target);
      if (!shouldDisconnect) return;
    }
    setBusyId(targetId);
    setSelectedId(targetId);
    try {
      await window.ade.remoteRuntime.disconnect(targetId, { manual: true });
      setConnected((current) =>
        current?.target.id === targetId ? null : current,
      );
      setConnectionSnapshot((current) => {
        if (!current) return current;
        const connections = current.connections.map((entry) =>
          entry.target.id === targetId
            ? {
                ...entry,
                state: "idle" as const,
                lastError: null,
                connectedAt: null,
              }
            : entry,
        );
        return {
          connections,
          connectedCount: connections.filter(
            (entry) => entry.state === "connected",
          ).length,
          updatedAt: Date.now(),
        };
      });
      setError(null);
      setHostKeyTrust(null);
    } catch (err) {
      setError(formatRemoteTargetError(err));
    } finally {
      setBusyId(null);
    }
  }, [onDisconnectRequested, targets]);

  const removeTarget = useCallback(
    async (targetId: string) => {
      const target = targets.find((entry) => entry.id === targetId) ?? null;
      if (target && onRemoveRequested) {
        const shouldRemove = await onRemoveRequested(target);
        if (!shouldRemove) return;
      }
      setBusyId(targetId);
      try {
        await window.ade.remoteRuntime.removeTarget(targetId);
        setTargets((current) =>
          current.filter((target) => target.id !== targetId),
        );
        if (selectedId === targetId) {
          setSelectedId(null);
          setConnected(null);
        }
        if (formPrefill?.targetId === targetId) setFormPrefill(null);
        setError(null);
      } catch (err) {
        setError(formatRemoteTargetError(err));
      } finally {
        setBusyId(null);
      }
    },
    [formPrefill?.targetId, onRemoveRequested, selectedId, targets],
  );

  const connectedCount =
    connectionSnapshot?.connectedCount ?? (connected ? 1 : 0);

  return (
    <div style={panelStyle}>
      <div style={sectionStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
                fontSize: 15,
                fontWeight: 700,
              }}
            >
              <DesktopTower size={18} weight="duotone" color={COLORS.accent} />
              Machines
            </div>
            <div style={helperTextStyle}>
              {connectedCount} connected
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              disabled={loadingDiscovered}
              onClick={() => void loadDiscoveredMachines()}
              style={{
                ...outlineButton({
                  height: 30,
                  padding: "0 10px",
                  fontSize: 11,
                }),
                opacity: loadingDiscovered ? 0.6 : 1,
              }}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={openManualAddForm}
              style={primaryButton({
                height: 30,
                padding: "0 12px",
                fontSize: 11,
              })}
            >
              Add machine
            </button>
          </div>
        </div>

        {manualAddOpen ? (
          <div style={inlineDetailStyle}>
            <div
              style={{
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              Add machine
            </div>
            <RemoteTargetForm
              busy={saving || busyId != null}
              prefill={formPrefill}
              submitLabel="Connect"
              onSubmit={saveAndConnect}
            />
          </div>
        ) : null}

        {discoveryError ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: COLORS.warning,
              fontFamily: SANS_FONT,
              fontSize: 12,
            }}
          >
            <Warning size={15} weight="fill" />
            {discoveryError}
          </div>
        ) : null}

        {loading ? (
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12 }}>
            Loading machines...
          </div>
        ) : null}

        <div style={{ display: "grid", gap: 8 }}>
          {targets.map((target) => {
            const targetStatus =
              connectionSnapshot?.connections.find(
                (entry) => entry.target.id === target.id,
              ) ?? null;
            const targetConnected = targetStatus
              ? targetStatus.state === "connected"
              : connected?.target.id === target.id;
            const targetConnecting =
              busyId === target.id || targetStatus?.state === "connecting";
            const targetSelected = selectedId === target.id;
            const targetError = targetSelected
              ? (error ?? selectedConnectionError)
              : targetStatus?.lastError
                ? formatRemoteTargetError(targetStatus.lastError)
                : null;
            const targetWarnings = targetSelected
              ? selectedCompatibilityWarnings
              : targetStatus?.compatibilityWarnings ?? [];
            const version =
              targetStatus?.version ??
              (connected?.target.id === target.id ? connected.version : null) ??
              target.runtimeBinaryVersion ??
              null;
            const arch =
              targetStatus?.arch ??
              (connected?.target.id === target.id ? connected.arch : null) ??
              target.lastSeenArch ??
              null;
            const statusLabel = connectionStateLabel(
              targetStatus,
              connected?.target.id === target.id ? connected : null,
            );
            const formOpen = formPrefill?.targetId === target.id;

            return (
              <div key={target.id} style={{ display: "grid", gap: 8 }}>
                <div
                  style={{
                    ...machineRowStyle,
                    borderColor: targetSelected ? COLORS.accent : COLORS.border,
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) auto",
                      gap: 12,
                      alignItems: "start",
                    }}
                  >
                    <div style={{ minWidth: 0, display: "grid", gap: 5 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            color: COLORS.textPrimary,
                            fontFamily: MONO_FONT,
                            fontSize: 13,
                            fontWeight: 700,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {target.name}
                        </span>
                        {targetConnected ? (
                          <CheckCircle
                            size={15}
                            weight="fill"
                            color={COLORS.success}
                          />
                        ) : null}
                      </div>
                      <div
                        style={{
                          color: COLORS.textMuted,
                          fontFamily: MONO_FONT,
                          fontSize: 12,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {targetConnectionLabel(target)}
                      </div>
                      <div style={helperTextStyle}>
                        <span>{statusLabel}</span>
                        {version || arch ? (
                          <span>{` · ADE ${version ?? "unknown"} on ${arch ?? "unknown"}`}</span>
                        ) : null}
                        <span>{` · ${formatLastSeen(target.lastConnectedAt)}`}</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {targetConnected ? (
                        <button
                          type="button"
                          disabled={busyId != null}
                          onClick={() => void disconnectTarget(target.id)}
                          style={outlineButton({
                            height: 30,
                            padding: "0 10px",
                            fontSize: 11,
                          })}
                        >
                          Disconnect
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busyId != null}
                          onClick={() => void connectTarget(target.id)}
                          style={primaryButton({
                            height: 30,
                            padding: "0 10px",
                            fontSize: 11,
                          })}
                        >
                          <PlugsConnected size={14} weight="bold" />
                          {targetConnecting ? "Connecting..." : "Connect"}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-controls={`remote-target-edit-${target.id}`}
                        aria-expanded={formOpen}
                        disabled={busyId != null}
                        onClick={() => toggleEditForm(target)}
                        style={outlineButton({
                          height: 30,
                          padding: "0 10px",
                          fontSize: 11,
                        })}
                      >
                        Edit
                        {formOpen ? (
                          <CaretUp size={12} weight="bold" />
                        ) : (
                          <CaretDown size={12} weight="bold" />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${target.name}`}
                        disabled={busyId != null}
                        onClick={() => void removeTarget(target.id)}
                        style={outlineButton({
                          height: 30,
                          padding: "0 9px",
                          fontSize: 11,
                        })}
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>

                  {targetError ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        color: COLORS.danger,
                        fontFamily: SANS_FONT,
                        fontSize: 12,
                      }}
                    >
                      <Warning size={15} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>{targetError}</span>
                    </div>
                  ) : null}

                  {targetWarnings.length > 0 ? (
                    <div
                      style={{
                        display: "grid",
                        gap: 4,
                        color: COLORS.warning,
                        fontFamily: SANS_FONT,
                        fontSize: 12,
                      }}
                    >
                      {targetWarnings.map((warning) => (
                        <div key={warning} style={{ display: "flex", gap: 6 }}>
                          <Warning size={14} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
                          <span>{warning}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {targetSelected && selectedHostKeyTrust ? (
                    <div
                      style={{
                        display: "grid",
                        gap: 10,
                        borderRadius: 8,
                        border: `1px solid ${
                          selectedHostKeyTrust.state === "changed"
                            ? COLORS.danger
                            : COLORS.warning
                        }`,
                        background:
                          selectedHostKeyTrust.state === "changed"
                            ? `color-mix(in srgb, ${COLORS.danger} 10%, transparent)`
                            : `color-mix(in srgb, ${COLORS.warning} 10%, transparent)`,
                        padding: "10px 12px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          color:
                            selectedHostKeyTrust.state === "changed"
                              ? COLORS.danger
                              : COLORS.warning,
                          fontFamily: SANS_FONT,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        <Warning size={15} weight="fill" />
                        {selectedHostKeyTrust.state === "changed"
                          ? "Machine identity changed"
                          : "Trust this machine"}
                      </div>
                      <div style={helperTextStyle}>
                        {selectedHostKeyTrust.state === "changed"
                          ? `ADE found a different SSH identity for ${selectedHostKeyTrust.host}:${selectedHostKeyTrust.port}. Review ${selectedHostKeyTrust.knownHostsPath ?? "known_hosts"} before connecting.`
                          : `ADE found a new SSH identity for ${selectedHostKeyTrust.host}:${selectedHostKeyTrust.port}. Trust it once to connect.`}
                      </div>
                      <div
                        style={{
                          color: COLORS.textPrimary,
                          fontFamily: MONO_FONT,
                          fontSize: 11,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {selectedHostKeyTrust.fingerprintSha256}
                      </div>
                      {selectedHostKeyTrust.state === "needs_trust" ? (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            disabled={trustingHostKey || busyId != null}
                            onClick={() => void trustAndConnect()}
                            style={{
                              ...primaryButton({
                                height: 30,
                                padding: "0 10px",
                                fontSize: 11,
                              }),
                              opacity: trustingHostKey || busyId != null ? 0.65 : 1,
                            }}
                          >
                            <CheckCircle size={15} weight="bold" />
                            {trustingHostKey ? "Trusting..." : "Trust & connect"}
                          </button>
                          <button
                            type="button"
                            disabled={trustingHostKey}
                            onClick={() => setHostKeyTrust(null)}
                            style={outlineButton({
                              height: 30,
                              padding: "0 10px",
                              fontSize: 11,
                            })}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {formOpen ? (
                  <div
                    id={`remote-target-edit-${target.id}`}
                    style={inlineDetailStyle}
                  >
                    <div
                      style={{
                        color: COLORS.textPrimary,
                        fontFamily: SANS_FONT,
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      Edit {target.name}
                    </div>
                    <RemoteTargetForm
                      busy={saving || busyId != null}
                      prefill={formPrefill}
                      submitLabel="Save and connect"
                      onSubmit={saveAndConnect}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}

          {visibleDiscoveredMachines.map((machine) => {
            const route = discoveredRoute(machine);
            const formOpen = activeFormKey === `${machine.id}:${machine.lastSeenAt}`;
            return (
              <div key={machine.id} style={{ display: "grid", gap: 8 }}>
                <div style={machineRowStyle}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) auto",
                      gap: 12,
                      alignItems: "center",
                    }}
                  >
                    <div style={{ minWidth: 0, display: "grid", gap: 5 }}>
                      <div
                        style={{
                          color: COLORS.textPrimary,
                          fontFamily: MONO_FONT,
                          fontSize: 13,
                          fontWeight: 700,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {machine.machineName}
                      </div>
                      <div
                        style={{
                          color: COLORS.textMuted,
                          fontFamily: MONO_FONT,
                          fontSize: 12,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {route ? `${route}:${machine.port}` : "No route advertised"}
                      </div>
                      <div style={helperTextStyle}>
                        Detected · {discoveredRuntimeLabel(machine)} ·{" "}
                        {discoveredProjectLabel(machine)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        disabled={!route || busyId != null || saving}
                        onClick={() => void connectDiscoveredMachine(machine)}
                        style={{
                          ...primaryButton({
                            height: 30,
                            padding: "0 10px",
                            fontSize: 11,
                          }),
                          opacity: route && busyId == null && !saving ? 1 : 0.55,
                        }}
                      >
                        <PlugsConnected size={14} weight="bold" />
                        {busyId === machine.id ? "Connecting..." : "Connect"}
                      </button>
                      <button
                        type="button"
                        aria-controls={`remote-discovered-edit-${machine.id}`}
                        aria-expanded={formOpen}
                        disabled={busyId != null}
                        onClick={() => toggleDiscoveredForm(machine)}
                        style={outlineButton({
                          height: 30,
                          padding: "0 10px",
                          fontSize: 11,
                        })}
                      >
                        Edit
                        {formOpen ? (
                          <CaretUp size={12} weight="bold" />
                        ) : (
                          <CaretDown size={12} weight="bold" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                {formOpen ? (
                  <div
                    id={`remote-discovered-edit-${machine.id}`}
                    style={inlineDetailStyle}
                  >
                    <div
                      style={{
                        color: COLORS.textPrimary,
                        fontFamily: SANS_FONT,
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      Edit {machine.machineName}
                    </div>
                    <RemoteTargetForm
                      busy={saving || busyId != null}
                      prefill={formPrefill}
                      submitLabel="Save and connect"
                      onSubmit={saveAndConnect}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {!loading && targets.length === 0 && !manualAddOpen && !loadingDiscovered && visibleDiscoveredMachines.length === 0 ? (
          <div style={helperTextStyle}>
            {discoveredMachines.length > 0
              ? "Nearby machines are already saved."
              : "No saved or detected machines yet."}
          </div>
        ) : null}
        {loadingDiscovered ? (
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12 }}>
            Scanning nearby machines...
          </div>
        ) : null}
        {!loadingDiscovered && targets.length > 0 && visibleDiscoveredMachines.length === 0 && discoveredMachines.length > 0 ? (
          <div style={helperTextStyle}>Nearby machines are already saved.</div>
        ) : null}
      </div>
    </div>
  );
}
