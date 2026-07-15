import { useCallback, useEffect, useMemo, useState } from "react";
import { DesktopTower, ShareNetwork, Warning } from "@phosphor-icons/react";
import { extractError } from "../../lib/format";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import type {
  AdeAccountMachine,
  AdeAccountMachinesResult,
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
import { ShareMachineCard } from "./ShareMachineCard";
import { PairMachineForm } from "./PairMachineForm";
import {
  assignMachineSections,
  discoveredTargetInput,
  formatRemoteTargetError,
  type MachineSection,
} from "./remoteMachineModel";
import { SavedMachineRow } from "./SavedMachineRow";
import { DiscoveredMachineRow } from "./DiscoveredMachineRow";
import { AccountMachineRow, accountMachineConnectHost } from "./AccountMachineRow";
import {
  helperTextStyle,
  inlineDetailStyle,
  panelStyle,
  sectionHeaderStyle,
} from "./remoteTargetListStyles";

type RemoteTargetListProps = {
  onConnected?: (result: RemoteRuntimeConnectResult) => void;
  onDisconnectRequested?: (
    target: RemoteRuntimeTarget,
  ) => boolean | Promise<boolean>;
  onRemoveRequested?: (
    target: RemoteRuntimeTarget,
  ) => boolean | Promise<boolean>;
  /** Account-directory machines, merged into the sections alongside saved/discovered. */
  accountMachines?: AdeAccountMachine[];
  accountMachinesState?: AdeAccountMachinesResult["state"];
  accountMachinesMessage?: string | null;
};

type ConnectTargetOptions = {
  skipHostKeyTrustCheck?: boolean;
};

type AddMode = { tab: "pair" | "ssh" };

function targetFormPrefill(
  target: RemoteRuntimeTarget,
): RemoteTargetFormPrefill {
  return {
    key: `target:${target.id}:${target.lastConnectedAt ?? "never"}:${target.transport ?? "ssh"}:${target.pairedMachine?.hostIdentity ?? ""}:${target.pairedMachine?.machineKey ?? ""}:${target.sshUser ?? ""}:${target.port ?? ""}:${target.sshKeyPath ?? ""}`,
    targetId: target.id,
    name: target.name,
    hostname: target.hostname,
    sshUser: target.sshUser,
    port: target.port,
    sshKeyPath: target.sshKeyPath,
    routes: target.routes ?? null,
    transport: target.transport,
    pairedMachine: target.pairedMachine,
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
  accountMachines,
  accountMachinesState,
  accountMachinesMessage,
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
        accountMachines,
      }),
    [targets, statusById, connected, discoveredMachines, accountMachines],
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
    const status = selectedId ? (statusById.get(selectedId) ?? null) : null;
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
        if (!cancelled && info.machineName)
          setLocalMachineName(info.machineName);
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
          const connectedEntry: RemoteRuntimeConnectionStatus = {
            target: result.target,
            state: "connected",
            arch: result.arch,
            version: result.version,
            route: result.route,
            capabilities: result.capabilities,
            compatibilityWarnings: result.compatibilityWarnings,
            projects: result.projects,
            lastError: null,
            lastAttemptedAt: Date.now(),
            connectedAt: result.target.lastConnectedAt ?? Date.now(),
          };
          const connections = existing.some(
            (entry) => entry.target.id === result.target.id,
          )
            ? existing.map((entry) =>
                entry.target.id === result.target.id ? connectedEntry : entry,
              )
            : [...existing, connectedEntry];
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
        let trustRequired = false;
        try {
          trustRequired = !(await ensureHostKeyTrust(targetId));
        } catch {
          // Preserve the connect failure when a follow-up trust probe also fails.
        }
        if (!trustRequired) setError(formatRemoteTargetError(err));
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

  const connectAccountMachine = useCallback(
    async (machine: AdeAccountMachine) => {
      const hostInfo = accountMachineConnectHost(machine);
      if (!hostInfo) return;
      const input: RemoteRuntimeTargetInput = {
        name: machine.name ?? hostInfo.host,
        hostname: hostInfo.host.replace(/\.$/, ""),
        sshUser: null,
        // hostInfo.port is the ADE service port (lan/tailnet), not an SSH port —
        // leave it null so the SSH transport falls back to its default (22).
        port: null,
        sshKeyPath: null,
        routes: null,
      };
      setBusyId(`account:${machine.machineKey}`);
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

  const disconnectTarget = useCallback(
    async (targetId: string) => {
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
    },
    [onDisconnectRequested, targets],
  );

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

  function renderSection(section: MachineSection) {
    const rows = sections[section];
    if (rows.length === 0) return null;
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={sectionHeaderStyle}>{SECTION_LABELS[section]}</div>
        {rows.map((row) => {
          if (row.kind === "saved") {
            return (
              <SavedMachineRow
                key={row.id}
                row={row}
                section={section}
                selected={selectedId === row.target.id}
                connected={connected}
                busyId={busyId}
                saving={saving}
                formPrefill={formPrefill}
                testOpen={testingId === row.target.id}
                error={error}
                hostKeyTrust={
                  selectedId === row.target.id ? selectedHostKeyTrust : null
                }
                trustingHostKey={trustingHostKey}
                onConnect={(targetId) => void connectTarget(targetId)}
                onDisconnect={(targetId) => void disconnectTarget(targetId)}
                onToggleTest={toggleTest}
                onToggleEdit={toggleEditForm}
                onRemove={(targetId) => void removeTarget(targetId)}
                onSaveAndConnect={saveAndConnect}
                onTrustAndConnect={() => void trustAndConnect()}
                onCancelHostKeyTrust={() => setHostKeyTrust(null)}
              />
            );
          }
          if (row.kind === "account") {
            return (
              <AccountMachineRow
                key={row.id}
                row={row}
                section={section}
                busy={busyId != null}
                connecting={busyId === row.id}
                detailOpen={testingId === row.id}
                onToggleDetail={toggleTest}
                onConnect={(machine) => void connectAccountMachine(machine)}
              />
            );
          }
          return (
            <DiscoveredMachineRow
              key={row.id}
              machine={row.machine}
              section={section}
              busyId={busyId}
              saving={saving}
              testOpen={testingId === row.machine.id}
              onConnect={(machine) => void connectDiscoveredMachine(machine)}
              onToggleTest={toggleTest}
            />
          );
        })}
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
              style={outlineButton({
                height: 30,
                padding: "0 10px",
                fontSize: 11,
              })}
            >
              <ShareNetwork size={14} weight="bold" />
              Share
            </button>
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
              onClick={openAddMachine}
              aria-expanded={addMode != null}
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

        {shareOpen ? <ShareMachineCard /> : null}

        {addMode ? (
          <div style={inlineDetailStyle}>
            <div
              style={{ display: "flex", gap: 4 }}
              role="tablist"
              aria-label="Add machine"
            >
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
          <div
            style={{
              color: COLORS.textMuted,
              fontFamily: MONO_FONT,
              fontSize: 12,
            }}
          >
            Loading machines…
          </div>
        ) : null}

        {renderSection("connected")}
        {renderSection("available")}
        {renderSection("unavailable")}

        {accountMachinesState && accountMachinesState !== "ok" && accountMachinesState !== "signed_out" ? (
          <div style={helperTextStyle}>
            {accountMachinesState === "not_configured"
              ? "Your account machine directory isn't live yet — saved and nearby machines still connect."
              : (accountMachinesMessage ?? "Can't reach your account machines right now.")}
          </div>
        ) : null}

        {!loading && totalRows === 0 && !addMode && !loadingDiscovered ? (
          <div style={helperTextStyle}>
            {discoveredMachines.length > 0
              ? "Nearby machines are already saved."
              : "No saved or detected machines yet."}
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
