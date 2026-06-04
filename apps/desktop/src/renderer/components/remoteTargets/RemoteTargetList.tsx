import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  CheckCircle,
  DesktopTower,
  PlugsConnected,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { extractError } from "../../lib/format";
import {
  COLORS,
  LABEL_STYLE,
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
};

type ConnectTargetOptions = {
  skipHostKeyTrustCheck?: boolean;
};

const panelStyle: CSSProperties = {
  display: "grid",
  gap: 14,
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  borderRadius: 10,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(255,255,255,0.025)",
  padding: 14,
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
    return "Use host to add this SSH target";
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
    const identity = routeIdentity(route.hostname, route.port ?? machine.port);
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

export function RemoteTargetList({ onConnected }: RemoteTargetListProps) {
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
  const editingSavedTarget = formPrefill?.targetId
    ? (targets.find((target) => target.id === formPrefill.targetId) ?? null)
    : null;
  const selectedConnectionLabel = connectionStateLabel(
    selectedConnection,
    connected?.target.id === selectedId ? connected : null,
  );
  const selectedConnectionError =
    selectedConnection?.state === "error" ? selectedConnection.lastError : null;
  const selectedCompatibilityWarnings =
    selectedConnection?.compatibilityWarnings ?? connected?.compatibilityWarnings ?? [];
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
      setError(extractError(err));
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

  useEffect(() => {
    if (!selectedTarget) return;
    setFormPrefill(targetFormPrefill(selectedTarget));
  }, [selectedTarget]);

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

  const applyDiscoveredRoute = useCallback(
    (machine: RemoteRuntimeDiscoveredMachine) => {
      const route = discoveredRoute(machine);
      if (!route) return;
      setFormPrefill({
        key: `${machine.id}:${machine.lastSeenAt}`,
        targetId: null,
        name: machine.machineName,
        hostname: route.replace(/\.$/, ""),
        sshUser: null,
        port: null,
        sshKeyPath: null,
        routes: discoveredSshRoutes(machine),
      });
    },
    [],
  );

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
      try {
        if (!options.skipHostKeyTrustCheck) {
          const trusted = await ensureHostKeyTrust(targetId);
          if (!trusted) return;
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
      } catch (err) {
        setError(extractError(err));
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
      setError(extractError(err));
    } finally {
      setTrustingHostKey(false);
    }
  }, [connectTarget, selectedHostKeyTrust]);

  const saveAndConnect = useCallback(
    async (input: RemoteRuntimeTargetInput) => {
      setSaving(true);
      try {
        const replacedTargetId = formPrefill?.targetId ?? null;
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
        setFormPrefill(targetFormPrefill(target));
        setError(null);
        await connectTarget(target.id);
      } catch (err) {
        setError(extractError(err));
      } finally {
        setSaving(false);
      }
    },
    [connectTarget, formPrefill?.targetId],
  );

  const removeTarget = useCallback(
    async (targetId: string) => {
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
        setError(extractError(err));
      } finally {
        setBusyId(null);
      }
    },
    [formPrefill?.targetId, selectedId],
  );

  return (
    <div style={panelStyle}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) minmax(300px,0.8fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: 16 }}>
          <div style={sectionStyle}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>
                  REMOTE MACHINES
                </div>
                <div
                  style={{
                    color: COLORS.textPrimary,
                    fontFamily: SANS_FONT,
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  Connect over SSH
                </div>
              </div>
              <DesktopTower size={22} weight="duotone" color={COLORS.accent} />
            </div>
            {loading ? (
              <div
                style={{
                  color: COLORS.textMuted,
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                }}
              >
                Loading machines...
              </div>
            ) : targets.length === 0 ? (
              <div
                style={{
                  color: COLORS.textMuted,
                  fontFamily: SANS_FONT,
                  fontSize: 13,
                }}
              >
                No remote machines saved yet.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {targets.map((target) => {
                  const active = selectedId === target.id;
                  const targetStatus =
                    connectionSnapshot?.connections.find(
                      (entry) => entry.target.id === target.id,
                    ) ?? null;
                  const isConnected = targetStatus
                    ? targetStatus.state === "connected"
                    : connected?.target.id === target.id;
                  return (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => {
                        setSelectedId(target.id);
                        setFormPrefill(targetFormPrefill(target));
                        if (selectedId !== target.id) setConnected(null);
                      }}
                      style={{
                        display: "grid",
                        gap: 6,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                        background: active
                          ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                          : "rgba(255,255,255,0.02)",
                        color: COLORS.textPrimary,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {target.name}
                        </span>
                        {isConnected ? (
                          <CheckCircle
                            size={16}
                            weight="fill"
                            color={COLORS.success}
                          />
                        ) : null}
                      </div>
                      <span
                        style={{
                          color: COLORS.textMuted,
                          fontFamily: MONO_FONT,
                          fontSize: 11,
                        }}
                      >
                        {targetConnectionLabel(target)}
                      </span>
                      <span
                        style={{
                          color: COLORS.textDim,
                          fontFamily: SANS_FONT,
                          fontSize: 11,
                        }}
                      >
                        {formatLastSeen(target.lastConnectedAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={sectionStyle}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>
                  NEARBY MACHINES
                </div>
                <div
                  style={{
                    color: COLORS.textPrimary,
                    fontFamily: SANS_FONT,
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  LAN and Tailscale discovery
                </div>
              </div>
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
            </div>
            {discoveryError ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: COLORS.danger,
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                }}
              >
                <Warning size={15} weight="fill" />
                {discoveryError}
              </div>
            ) : null}
            {loadingDiscovered ? (
              <div
                style={{
                  color: COLORS.textMuted,
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                }}
              >
                Scanning nearby machines...
              </div>
            ) : visibleDiscoveredMachines.length === 0 ? (
              <div
                style={{
                  color: COLORS.textMuted,
                  fontFamily: SANS_FONT,
                  fontSize: 13,
                }}
              >
                {discoveredMachines.length > 0
                  ? "Nearby machines are already saved above."
                  : "No LAN ADE services or Tailscale peers found."}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {visibleDiscoveredMachines.map((machine) => {
                  const route = discoveredRoute(machine);
                  return (
                    <div
                      key={machine.id}
                      style={{
                        display: "grid",
                        gap: 6,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: `1px solid ${COLORS.border}`,
                        background: "rgba(255,255,255,0.02)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              color: COLORS.textPrimary,
                              fontFamily: MONO_FONT,
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          >
                            {machine.machineName}
                          </div>
                          <div
                            style={{
                              color: COLORS.textMuted,
                              fontFamily: MONO_FONT,
                              fontSize: 11,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {route
                              ? `${route}:${machine.port}`
                              : "No route advertised"}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={!route}
                          onClick={() => applyDiscoveredRoute(machine)}
                          style={{
                            ...outlineButton({
                              height: 28,
                              padding: "0 10px",
                              fontSize: 11,
                            }),
                            opacity: route ? 1 : 0.55,
                            flexShrink: 0,
                          }}
                        >
                          Use host
                        </button>
                      </div>
                      <div
                        style={{
                          color: COLORS.textDim,
                          fontFamily: SANS_FONT,
                          fontSize: 11,
                        }}
                      >
                        {discoveredRuntimeLabel(machine)} |{" "}
                        {discoveredProjectLabel(machine)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div style={sectionStyle}>
          <div>
            <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>
              {editingSavedTarget ? "EDIT MACHINE" : "ADD MACHINE"}
            </div>
            <div
              style={{
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {editingSavedTarget ? editingSavedTarget.name : "SSH target"}
            </div>
          </div>
          <RemoteTargetForm
            busy={saving || busyId != null}
            prefill={formPrefill}
            submitLabel={editingSavedTarget ? "Save and connect" : "Connect"}
            onSubmit={saveAndConnect}
          />
        </div>
      </div>

      <div style={sectionStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>
              CONNECTION
            </div>
            <div
              style={{
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {selectedTarget ? selectedTarget.name : "Select a machine"}
            </div>
          </div>
          {selectedTarget ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={primaryButton({
                  height: 32,
                  padding: "0 12px",
                  fontSize: 12,
                })}
                disabled={busyId != null}
                onClick={() => void connectTarget(selectedTarget.id)}
              >
                <PlugsConnected size={15} weight="bold" />
                {selectedConnection?.state === "connected"
                  ? "Reconnect"
                  : "Connect"}
              </button>
              <button
                type="button"
                aria-label="Remove remote machine"
                style={outlineButton({
                  height: 32,
                  padding: "0 10px",
                  fontSize: 12,
                })}
                disabled={busyId != null}
                onClick={() => void removeTarget(selectedTarget.id)}
              >
                <Trash size={15} />
              </button>
            </div>
          ) : null}
        </div>

        {selectedHostKeyTrust ? (
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
            <div
              style={{
                color: COLORS.textMuted,
                fontFamily: SANS_FONT,
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {selectedHostKeyTrust.state === "changed"
                ? `ADE found a different SSH identity for ${selectedHostKeyTrust.host}:${selectedHostKeyTrust.port}. Review ${selectedHostKeyTrust.knownHostsPath ?? "known_hosts"} before connecting.`
                : `ADE found a new SSH identity for ${selectedHostKeyTrust.host}:${selectedHostKeyTrust.port}. Trust it once to connect over Wi-Fi or Tailscale.`}
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

        {error || selectedConnectionError ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: COLORS.danger,
              fontFamily: SANS_FONT,
              fontSize: 12,
            }}
          >
            <Warning size={15} weight="fill" />
            {error ?? selectedConnectionError}
          </div>
        ) : null}

        {selectedTarget ? (
          <div
            style={{
              display: "grid",
              gap: 8,
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: "rgba(255,255,255,0.02)",
              padding: "10px 12px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    color: COLORS.textPrimary,
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {selectedConnectionLabel}
                </div>
                <div
                  style={{
                    color: COLORS.textMuted,
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {targetConnectionLabel(selectedTarget)}
                </div>
              </div>
              {selectedConnection?.state === "connected" ||
              (!selectedConnection &&
                connected?.target.id === selectedTarget.id) ? (
                <CheckCircle size={17} weight="fill" color={COLORS.success} />
              ) : null}
            </div>
            {selectedConnection?.state === "connected" ||
            (!selectedConnection &&
              connected?.target.id === selectedTarget.id) ? (
              <>
                <div
                  style={{
                    color: COLORS.textMuted,
                    fontFamily: SANS_FONT,
                    fontSize: 12,
                  }}
                >
                  ADE service{" "}
                  {selectedConnection?.version ?? connected?.version ?? "unknown"}{" "}
                  on {selectedConnection?.arch ?? connected?.arch ?? "unknown"}.
                </div>
                {selectedCompatibilityWarnings.length > 0 ? (
                  <div
                    style={{
                      display: "grid",
                      gap: 4,
                      color: COLORS.warning,
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                    }}
                  >
                    {selectedCompatibilityWarnings.map((warning) => (
                      <div key={warning} style={{ display: "flex", gap: 6 }}>
                        <Warning size={14} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>{warning}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div
                style={{
                  color: COLORS.textMuted,
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                }}
              >
                Remote projects are opened from Add Project after this machine
                is connected.
              </div>
            )}
          </div>
        ) : (
          <div
            style={{
              color: COLORS.textMuted,
              fontFamily: SANS_FONT,
              fontSize: 12,
            }}
          >
            Save a machine to keep ADE connected in the background.
          </div>
        )}
      </div>
    </div>
  );
}
