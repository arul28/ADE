import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CaretLeft,
  CaretRight,
  DesktopTower,
  TerminalWindow,
  UserCircle,
  Warning,
  WifiHigh,
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
import { PairMachineForm } from "./PairMachineForm";
import {
  assignMachineSections,
  discoveredPairingInput,
  discoveredTargetInput,
  formatRemoteTargetError,
  isSshOnlyDiscovered,
  machineMatchesSavedTarget,
  type MachineSection,
} from "./remoteMachineModel";
import { SavedMachineRow } from "./SavedMachineRow";
import { DiscoveredMachineRow } from "./DiscoveredMachineRow";
import { AccountMachineRow } from "./AccountMachineRow";
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
  accountSignedIn?: boolean;
  onAccountRequested?: () => void;
};

type ConnectTargetOptions = {
  skipHostKeyTrustCheck?: boolean;
};

type AddMode = "choose" | "nearby" | "pair" | "ssh";

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
  accountSignedIn = false,
  onAccountRequested,
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
  const [testingId, setTestingId] = useState<string | null>(null);
  const [localMachineName, setLocalMachineName] = useState("");
  const [localMachineIdentity, setLocalMachineIdentity] =
    useState<{ machineKey: string; deviceId: string } | null>(null);
  const [pairingPrefill, setPairingPrefill] = useState<string | null>(null);

  // Never surface THIS Mac in its own account list. Match on the stable
  // machineKey OR deviceId reported by the local identity IPC (#A3).
  const visibleAccountMachines = useMemo(() => {
    if (!accountMachines) return accountMachines;
    const identity = localMachineIdentity;
    if (!identity) return accountMachines;
    return accountMachines.filter((machine) => {
      const keyMatch = identity.machineKey && machine.machineKey === identity.machineKey;
      const deviceMatch =
        identity.deviceId && machine.deviceId != null && machine.deviceId === identity.deviceId;
      return !keyMatch && !deviceMatch;
    });
  }, [accountMachines, localMachineIdentity]);

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
        accountMachines: visibleAccountMachines,
        includeDiscoveredRows: false,
      }),
    [targets, statusById, connected, discoveredMachines, visibleAccountMachines],
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
    if (!accountSignedIn) void loadTargets();
  }, [accountSignedIn, loadTargets]);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const identity = await window.ade.account?.getLocalMachineIdentity?.();
        if (!cancelled && identity) setLocalMachineIdentity(identity);
      } catch {
        // Identity is best-effort; without it the account list simply isn't self-filtered.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openAddMachine = useCallback(() => {
    setSelectedId(null);
    setFormPrefill(null);
    setError(null);
    setHostKeyTrust(null);
    setPairingPrefill(null);
    setAddMode((current) => (current ? null : "choose"));
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
      const directPairingInput = discoveredPairingInput(machine);
      if (directPairingInput) {
        setSelectedId(null);
        setHostKeyTrust(null);
        setError(null);
        setPairingPrefill(directPairingInput);
        setAddMode("pair");
        return;
      }
      if (isSshOnlyDiscovered(machine)) return;
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
      setBusyId(`account:${machine.machineKey}`);
      setSelectedId(null);
      setHostKeyTrust(null);
      setError(null);
      try {
        const paired = await window.ade.account.pairMachine(machine.machineKey);
        await loadTargets();
        await connectTarget(paired.targetId, { skipHostKeyTrustCheck: true });
      } catch (err) {
        setError(formatRemoteTargetError(err));
      } finally {
        setBusyId(null);
      }
    },
    [connectTarget, loadTargets],
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

  const setTargetAutoConnect = useCallback(async (targetId: string, enabled: boolean) => {
    setBusyId(targetId);
    try {
      const updated = await window.ade.remoteRuntime.setAutoConnect(targetId, enabled);
      setTargets((current) => current.map((target) => (
        target.id === updated.id ? updated : target
      )));
      setConnectionSnapshot((current) => current
        ? {
            ...current,
            connections: current.connections.map((entry) => (
              entry.target.id === updated.id ? { ...entry, target: updated } : entry
            )),
            updatedAt: Date.now(),
          }
        : current);
      setError(null);
    } catch (err) {
      setError(formatRemoteTargetError(err));
    } finally {
      setBusyId(null);
    }
  }, []);

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
                onAutoConnectChange={(targetId, enabled) => {
                  void setTargetAutoConnect(targetId, enabled);
                }}
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

  const nearbyMachines = useMemo(
    () => discoveredMachines.filter((machine) => (
      !isSshOnlyDiscovered(machine)
      && (machine.connectable === false || discoveredPairingInput(machine) != null)
      && !targets.some((target) => machineMatchesSavedTarget(machine, target))
    )),
    [discoveredMachines, targets],
  );

  const chooseAddMode = useCallback((next: Exclude<AddMode, "choose">) => {
    if (next !== "pair") setPairingPrefill(null);
    setAddMode(next);
  }, []);

  // Signed in, account Macs appear in the list automatically, so the add sheet
  // only offers Nearby + SSH. Signed out, we lead with the account sign-in.
  const addChoices = useMemo(
    () => {
      const choices: Array<{
        key: string;
        icon: typeof WifiHigh;
        label: string;
        detail: string;
        onSelect: () => void;
      }> = [];
      if (!accountSignedIn) {
        choices.push({
          key: "signin",
          icon: UserCircle,
          label: "Sign in to ADE",
          detail: "The easiest way to find and connect to your other Macs.",
          onSelect: () => onAccountRequested?.(),
        });
      }
      choices.push({
        key: "nearby",
        icon: WifiHigh,
        label: "Find nearby Macs",
        detail: "Search this Wi-Fi for Macs with ADE open.",
        onSelect: () => chooseAddMode("nearby"),
      });
      choices.push({
        key: "ssh",
        icon: TerminalWindow,
        label: "Add over SSH (Advanced)",
        detail: "Connect with the Mac's SSH address and private key.",
        onSelect: () => chooseAddMode("ssh"),
      });
      return choices;
    },
    [accountSignedIn, chooseAddMode, onAccountRequested],
  );

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

        {addMode ? (
          <div style={inlineDetailStyle}>
            {addMode !== "choose" ? (
              <button
                type="button"
                onClick={() => setAddMode("choose")}
                style={{
                  ...outlineButton({ height: 28, padding: "0 9px", fontSize: 11 }),
                  justifySelf: "start",
                }}
              >
                <CaretLeft size={13} weight="bold" />
                Add machine
              </button>
            ) : null}

            {addMode === "choose" ? (
              <div style={{ display: "grid" }}>
                {addChoices.map(({ key, icon: Icon, label, detail, onSelect }, index) => (
                  <button
                    key={key}
                    type="button"
                    onClick={onSelect}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "22px minmax(0, 1fr) 16px",
                      gap: 10,
                      alignItems: "center",
                      padding: "11px 4px",
                      border: "none",
                      borderTop: index === 0 ? "none" : `1px solid ${COLORS.borderMuted}`,
                      background: "transparent",
                      color: COLORS.textPrimary,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <Icon size={18} weight="regular" color={COLORS.textMuted} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontFamily: SANS_FONT, fontSize: 12.5, fontWeight: 600 }}>
                        {label}
                      </span>
                      <span style={{ display: "block", ...helperTextStyle, marginTop: 2 }}>
                        {detail}
                      </span>
                    </span>
                    <CaretRight size={14} weight="bold" color={COLORS.textDim} />
                  </button>
                ))}
              </div>
            ) : null}

            {addMode === "pair" ? (
              <PairMachineForm
                defaultDeviceName={localMachineName}
                initialInput={pairingPrefill}
                busy={saving || busyId != null}
                onPaired={onPaired}
              />
            ) : null}
            {addMode === "ssh" ? (
              <RemoteTargetForm
                busy={saving || busyId != null}
                submitLabel="Connect"
                onSubmit={saveAndConnect}
              />
            ) : null}
            {addMode === "nearby" ? (
              <div style={{ display: "grid", gap: 8 }}>
                {loadingDiscovered ? <div style={helperTextStyle}>Scanning nearby machines…</div> : null}
                {!loadingDiscovered && nearbyMachines.length === 0 ? (
                  <div style={helperTextStyle}>
                    No Macs found. Open ADE on the other Mac and make sure both are on the same Wi-Fi or Tailscale network.
                  </div>
                ) : null}
                {nearbyMachines.map((machine) => (
                  <DiscoveredMachineRow
                    key={machine.id}
                    machine={machine}
                    section={machine.connectable === false ? "unavailable" : "available"}
                    busyId={busyId}
                    saving={saving}
                    testOpen={testingId === machine.id}
                    onConnect={(next) => void connectDiscoveredMachine(next)}
                    onToggleTest={toggleTest}
                  />
                ))}
              </div>
            ) : null}
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
              ? "Account Macs aren't available yet. Saved and nearby Macs still work."
              : "We couldn't load your account Macs. Saved and nearby Macs still work."}
          </div>
        ) : null}

        {!loading && totalRows === 0 && !addMode && !loadingDiscovered ? (
          <div style={helperTextStyle}>
            No Macs yet. Choose Add machine to connect one.
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
      </div>
    </div>
  );
}
