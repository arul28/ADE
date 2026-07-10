import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CaretDown,
  CaretUp,
  CheckCircle,
  DesktopTower,
  PlugsConnected,
  ShareNetwork,
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
} from "../../../shared/types";
import {
  RemoteTargetForm,
  type RemoteTargetFormPrefill,
} from "./RemoteTargetForm";
import { RemoteErrorCard } from "./RemoteErrorCard";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import { ShareMachineCard } from "./ShareMachineCard";
import { PairMachineForm } from "./PairMachineForm";
import {
  assignMachineSections,
  connectionStateLabel,
  discoveredMachineSummary,
  discoveredRoute,
  discoveredTargetInput,
  formatLastSeen,
  formatRemoteTargetError,
  formatRouteChip,
  selectMachineErrorCard,
  targetConnectionLabel,
  type MachineSection,
  type SavedMachineRow,
} from "./remoteMachineModel";

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

type AddMode = { tab: "pair" | "ssh" };

const panelStyle: CSSProperties = {
  display: "grid",
  gap: 12,
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

const sectionHeaderStyle: CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: "0.08em",
};

const nameStyle: CSSProperties = {
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 13,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const subTextStyle: CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: MONO_FONT,
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

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

const SECTION_LABELS: Record<MachineSection, string> = {
  connected: "CONNECTED",
  available: "AVAILABLE",
  unavailable: "UNAVAILABLE",
};

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
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [localMachineName, setLocalMachineName] = useState("");

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? null,
    [selectedId, targets],
  );
  const selectedHostKeyTrust =
    selectedTarget && hostKeyTrust?.targetId === selectedTarget.id
      ? hostKeyTrust
      : null;

  const statusById = useMemo(() => {
    const map = new Map<string, RemoteRuntimeConnectionStatus>();
    for (const entry of connectionSnapshot?.connections ?? []) {
      map.set(entry.target.id, entry);
    }
    return map;
  }, [connectionSnapshot]);

  const sections = useMemo(
    () =>
      assignMachineSections({
        targets,
        statusById,
        connectedFallbackId: connected?.target.id ?? null,
        discoveredMachines,
      }),
    [targets, statusById, connected, discoveredMachines],
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
    const status = selectedId ? statusById.get(selectedId) ?? null : null;
    if (!status) return;
    if (status.state !== "connected") {
      setConnected((current) =>
        current?.target.id === status.target.id ? null : current,
      );
      return;
    }
    setConnected({
      target: status.target,
      arch: status.arch ?? status.target.lastSeenArch ?? "unknown",
      version: status.version ?? status.target.runtimeBinaryVersion,
      route: status.route,
      capabilities: status.capabilities,
      compatibilityWarnings: status.compatibilityWarnings,
      projects: status.projects,
    });
  }, [selectedId, statusById]);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await window.ade.remoteRuntime.getLocalPairingInfo();
        if (!cancelled && info.machineName) setLocalMachineName(info.machineName);
      } catch {
        // Pairing info is optional; the pair form still works with a typed name.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openAddMachine = useCallback(() => {
    setSelectedId(null);
    setShareOpen(false);
    setFormPrefill(null);
    setError(null);
    setHostKeyTrust(null);
    setAddMode((current) => (current ? null : { tab: "pair" }));
  }, []);

  const toggleShare = useCallback(() => {
    setShareOpen((open) => !open);
    setAddMode(null);
  }, []);

  const toggleTest = useCallback((rowId: string) => {
    setTestingId((current) => (current === rowId ? null : rowId));
  }, []);

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
                      route: result.route,
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
                  route: result.route,
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
        setTestingId(null);
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
        if (connectedOk) {
          setFormPrefill(null);
          setAddMode(null);
        }
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
      if (machine.connectable === false) return;
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

  const onPaired = useCallback(
    async (targetId: string) => {
      await loadTargets();
      const connectedOk = await connectTarget(targetId);
      if (connectedOk) setAddMode(null);
    },
    [connectTarget, loadTargets],
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
          current.filter((entry) => entry.id !== targetId),
        );
        if (selectedId === targetId) {
          setSelectedId(null);
          setConnected(null);
        }
        if (formPrefill?.targetId === targetId) setFormPrefill(null);
        if (testingId === targetId) setTestingId(null);
        setError(null);
      } catch (err) {
        setError(formatRemoteTargetError(err));
      } finally {
        setBusyId(null);
      }
    },
    [formPrefill?.targetId, onRemoveRequested, selectedId, targets, testingId],
  );

  const connectedCount =
    connectionSnapshot?.connectedCount ?? (connected ? 1 : 0);

  const totalRows =
    sections.connected.length +
    sections.available.length +
    sections.unavailable.length;

  function renderSavedRow(
    row: SavedMachineRow,
    section: MachineSection,
  ): ReactNode {
    const { target, status } = row;
    const targetSelected = selectedId === target.id;
    const targetConnecting =
      busyId === target.id || status?.state === "connecting";
    const version =
      status?.version ??
      (connected?.target.id === target.id ? connected.version : null) ??
      target.runtimeBinaryVersion ??
      null;
    const arch =
      status?.arch ??
      (connected?.target.id === target.id ? connected.arch : null) ??
      target.lastSeenArch ??
      null;
    const route =
      status?.route ??
      (connected?.target.id === target.id ? connected.route : undefined);
    const routeChip = row.connected ? formatRouteChip(route) : null;
    const statusLabel = connectionStateLabel(
      status ?? null,
      connected?.target.id === target.id,
    );
    const warnings = targetSelected
      ? status?.compatibilityWarnings ??
        (connected?.target.id === target.id
          ? connected.compatibilityWarnings
          : []) ??
        []
      : status?.compatibilityWarnings ?? [];
    const errorCard = selectMachineErrorCard({
      errorInfo: status?.state === "error" ? status.lastErrorInfo : null,
      rawError: status?.state === "error" ? status.lastError : null,
      overrideMessage: targetSelected ? error : null,
    });
    const formOpen = formPrefill?.targetId === target.id;
    const testOpen = testingId === target.id;

    return (
      <div key={target.id} style={{ display: "grid", gap: 8 }}>
        <div
          style={{
            ...machineRowStyle,
            opacity: section === "unavailable" ? 0.62 : 1,
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
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={nameStyle}>{target.name}</span>
                {row.connected ? (
                  <CheckCircle size={15} weight="fill" color={COLORS.success} />
                ) : null}
                {routeChip ? (
                  <span
                    style={{
                      color: COLORS.textMuted,
                      fontFamily: SANS_FONT,
                      fontSize: 11,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {routeChip}
                  </span>
                ) : null}
              </div>
              <div style={subTextStyle}>{targetConnectionLabel(target)}</div>
              <div style={helperTextStyle}>
                {section === "unavailable" && row.unavailableReason ? (
                  <span>{row.unavailableReason}</span>
                ) : (
                  <>
                    <span>{statusLabel}</span>
                    {version || arch ? (
                      <span>{` · ADE ${version ?? "unknown"} on ${arch ?? "unknown"}`}</span>
                    ) : null}
                    <span>{` · ${formatLastSeen(target.lastConnectedAt)}`}</span>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {row.connected ? (
                <button
                  type="button"
                  disabled={busyId != null}
                  onClick={() => void disconnectTarget(target.id)}
                  style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
                >
                  Disconnect
                </button>
              ) : section !== "unavailable" ? (
                <>
                  <button
                    type="button"
                    disabled={busyId != null}
                    onClick={() => void connectTarget(target.id)}
                    style={primaryButton({ height: 30, padding: "0 10px", fontSize: 11 })}
                  >
                    <PlugsConnected size={14} weight="bold" />
                    {targetConnecting ? "Connecting…" : "Connect"}
                  </button>
                  <button
                    type="button"
                    aria-controls={`remote-target-test-${target.id}`}
                    aria-expanded={testOpen}
                    disabled={busyId != null}
                    onClick={() => toggleTest(target.id)}
                    style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
                  >
                    Test
                  </button>
                </>
              ) : null}
              {section !== "unavailable" ? (
                <button
                  type="button"
                  aria-controls={`remote-target-edit-${target.id}`}
                  aria-expanded={formOpen}
                  disabled={busyId != null}
                  onClick={() => toggleEditForm(target)}
                  style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
                >
                  Edit
                  {formOpen ? (
                    <CaretUp size={12} weight="bold" />
                  ) : (
                    <CaretDown size={12} weight="bold" />
                  )}
                </button>
              ) : null}
              <button
                type="button"
                aria-label={`Remove ${target.name}`}
                disabled={busyId != null}
                onClick={() => void removeTarget(target.id)}
                style={outlineButton({ height: 30, padding: "0 9px", fontSize: 11 })}
              >
                <Trash size={14} />
              </button>
            </div>
          </div>

          {errorCard ? (
            <RemoteErrorCard
              card={errorCard}
              onRetry={
                busyId == null ? () => void connectTarget(target.id) : undefined
              }
              retrying={busyId === target.id}
            />
          ) : null}

          {warnings.length > 0 ? (
            <div
              style={{
                display: "grid",
                gap: 4,
                color: COLORS.warning,
                fontFamily: SANS_FONT,
                fontSize: 12,
              }}
            >
              {warnings.map((warning) => (
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
                      ...primaryButton({ height: 30, padding: "0 10px", fontSize: 11 }),
                      opacity: trustingHostKey || busyId != null ? 0.65 : 1,
                    }}
                  >
                    <CheckCircle size={15} weight="bold" />
                    {trustingHostKey ? "Trusting…" : "Trust & connect"}
                  </button>
                  <button
                    type="button"
                    disabled={trustingHostKey}
                    onClick={() => setHostKeyTrust(null)}
                    style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {testOpen ? (
          <div id={`remote-target-test-${target.id}`}>
            <ConnectionDoctorPanel machineId={target.id} />
          </div>
        ) : null}

        {formOpen ? (
          <div id={`remote-target-edit-${target.id}`} style={inlineDetailStyle}>
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
  }

  function renderDiscoveredRow(
    machine: RemoteRuntimeDiscoveredMachine,
    section: MachineSection,
  ): ReactNode {
    const route = discoveredRoute(machine);
    const testOpen = testingId === machine.id;
    const unavailable = section === "unavailable";
    return (
      <div key={machine.id} style={{ display: "grid", gap: 8 }}>
        <div style={{ ...machineRowStyle, opacity: unavailable ? 0.62 : 1 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1fr) auto",
              gap: 12,
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0, display: "grid", gap: 5 }}>
              <div style={nameStyle}>{machine.machineName}</div>
              <div style={subTextStyle}>
                {route ? `${route}:${machine.port}` : "No route advertised"}
              </div>
              <div style={helperTextStyle}>
                {unavailable && machine.unsupportedReason
                  ? machine.unsupportedReason
                  : discoveredMachineSummary(machine)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {!unavailable ? (
                <>
                  <button
                    type="button"
                    disabled={!route || busyId != null || saving}
                    onClick={() => void connectDiscoveredMachine(machine)}
                    style={{
                      ...primaryButton({ height: 30, padding: "0 10px", fontSize: 11 }),
                      opacity: route && busyId == null && !saving ? 1 : 0.55,
                    }}
                  >
                    <PlugsConnected size={14} weight="bold" />
                    {busyId === machine.id ? "Connecting…" : "Connect"}
                  </button>
                  <button
                    type="button"
                    aria-controls={`remote-discovered-test-${machine.id}`}
                    aria-expanded={testOpen}
                    disabled={busyId != null}
                    onClick={() => toggleTest(machine.id)}
                    style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
                  >
                    Test
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
        {testOpen ? (
          <div id={`remote-discovered-test-${machine.id}`}>
            <ConnectionDoctorPanel machineId={machine.id} />
          </div>
        ) : null}
      </div>
    );
  }

  function renderSection(section: MachineSection): ReactNode {
    const rows = sections[section];
    if (rows.length === 0) return null;
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={sectionHeaderStyle}>{SECTION_LABELS[section]}</div>
        {rows.map((row) =>
          row.kind === "saved"
            ? renderSavedRow(row, section)
            : renderDiscoveredRow(row.machine, section),
        )}
      </div>
    );
  }

  const activeTab = addMode?.tab ?? "pair";

  return (
    <div style={panelStyle}>
      <div style={{ display: "grid", gap: 12 }}>
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
            <div style={helperTextStyle}>{connectedCount} connected</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              onClick={toggleShare}
              aria-expanded={shareOpen}
              style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
            >
              <ShareNetwork size={14} weight="bold" />
              Share
            </button>
            <button
              type="button"
              disabled={loadingDiscovered}
              onClick={() => void loadDiscoveredMachines()}
              style={{
                ...outlineButton({ height: 30, padding: "0 10px", fontSize: 11 }),
                opacity: loadingDiscovered ? 0.6 : 1,
              }}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={openAddMachine}
              aria-expanded={addMode != null}
              style={primaryButton({ height: 30, padding: "0 12px", fontSize: 11 })}
            >
              Add machine
            </button>
          </div>
        </div>

        {shareOpen ? <ShareMachineCard /> : null}

        {addMode ? (
          <div style={inlineDetailStyle}>
            <div style={{ display: "flex", gap: 4 }} role="tablist" aria-label="Add machine">
              {(["pair", "ssh"] as const).map((tab) => {
                const active = activeTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setAddMode({ tab })}
                    style={{
                      height: 30,
                      padding: "0 12px",
                      borderRadius: 7,
                      border: "none",
                      cursor: "pointer",
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      fontWeight: 600,
                      color: active ? COLORS.textPrimary : COLORS.textMuted,
                      background: active
                        ? "color-mix(in srgb, var(--color-fg) 10%, transparent)"
                        : "transparent",
                    }}
                  >
                    {tab === "pair" ? "Pair" : "SSH"}
                  </button>
                );
              })}
            </div>
            {activeTab === "pair" ? (
              <PairMachineForm
                defaultDeviceName={localMachineName}
                busy={saving || busyId != null}
                onPaired={onPaired}
              />
            ) : (
              <RemoteTargetForm
                busy={saving || busyId != null}
                submitLabel="Connect"
                onSubmit={saveAndConnect}
              />
            )}
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
            Loading machines…
          </div>
        ) : null}

        {renderSection("connected")}
        {renderSection("available")}
        {renderSection("unavailable")}

        {!loading && totalRows === 0 && !addMode && !loadingDiscovered ? (
          <div style={helperTextStyle}>
            {discoveredMachines.length > 0
              ? "Nearby machines are already saved."
              : "No saved or detected machines yet."}
          </div>
        ) : null}
        {loadingDiscovered ? (
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12 }}>
            Scanning nearby machines…
          </div>
        ) : null}
        {!loadingDiscovered &&
        targets.length > 0 &&
        totalRows === targets.length &&
        discoveredMachines.length > 0 ? (
          <div style={helperTextStyle}>Nearby machines are already saved.</div>
        ) : null}
      </div>
    </div>
  );
}
