import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  CircleNotch,
  Desktop,
  Key,
  Laptop,
  Plus,
  PlugsConnected,
  TerminalWindow,
  UserCircle,
  Warning,
  WifiHigh,
  X,
} from "@phosphor-icons/react";
import { openExternalUrl } from "../../lib/openExternal";
import { ADE_SITE_URL } from "../../onboarding/docsLinks";
import "./connections.css";
import { extractError } from "../../lib/format";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
} from "../lanes/laneDesignTokens";
import type {
  AdeAccountMachine,
  AdeAccountMachinesResult,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeConnectResult,
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeDiscoveryDiagnostic,
  RemoteRuntimeDiscoverySeverity,
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
  accountMachineMatchesTarget,
  assignMachineSections,
  describePublishHealth,
  discoveredPairingInput,
  discoveredTargetInput,
  formatRemoteTargetError,
  describeMachineUpdateAttempt,
  isMachineVersionOutdated,
  machineUpdateGraceMs,
  machineUpdatePhase,
  outdatedMachines,
  isSshOnlyDiscovered,
  machineMatchesSavedTarget,
  newestKnownAdeVersion,
  type MachineSection,
} from "./remoteMachineModel";
import {
  connectedMachineIds,
  isMachineConnected,
} from "../../../shared/machinePresence";
import { SavedMachineRow } from "./SavedMachineRow";
import { MachinesBehindBanner } from "./MachinesBehindBanner";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import { isMachineUpdateBusy, requestMachineUpdates, useMachineUpdates } from "./machineUpdates";
import { DiscoveredMachineRow } from "./DiscoveredMachineRow";
import { AccountMachineRow } from "./AccountMachineRow";
import { accountRowKey, useRowActions } from "./useRowActions";
import {
  helperTextStyle,
  panelStyle,
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
  onAccountMachinesChanged?: () => void;
  /** The signed-in account's email, named in the "sign in on the other computer" steps. */
  accountEmail?: string | null;
  /**
   * This computer's pairing code controls, for a phone or a computer that is
   * not on the account. The add sheet shows them under "Use a pairing code".
   */
  thisComputerCode?: ReactNode;
};

type ConnectTargetOptions = {
  skipHostKeyTrustCheck?: boolean;
  onError?: (message: string) => void;
  /**
   * The connect was stopped because this machine's SSH identity has to be
   * confirmed first. Distinct from `onError`: nothing failed, and the caller
   * has to reveal the trust prompt rather than report a failure.
   */
  onTrustRequired?: (state: "needs_trust" | "changed") => void;
};

type AddMode = "choose" | "nearby" | "pair" | "ssh" | "code";

type AccountConnectionToast = {
  targetId: string;
  label: string;
};

const ACCOUNT_CONNECTION_TOAST_MS = 4_000;

function accountMachineMatchesNearby(
  accountMachine: AdeAccountMachine,
  discoveredMachine: RemoteRuntimeDiscoveredMachine,
): boolean {
  const accountDeviceId = accountMachine.deviceId?.trim() ?? "";
  const discoveredDeviceId = discoveredMachine.hostIdentity?.trim() ?? "";
  if (accountDeviceId && discoveredDeviceId) {
    return accountDeviceId === discoveredDeviceId;
  }
  // Nearby discovery advertises the reported hostname, never the account label.
  const accountName = accountMachine.name?.trim().toLowerCase() ?? "";
  const discoveredName = discoveredMachine.machineName.trim().toLowerCase();
  return Boolean(accountName && discoveredName && accountName === discoveredName);
}

function connectedViaLabel(result: RemoteRuntimeConnectResult): string | null {
  if (!result.route) return null;
  const routeLabel = {
    lan: "local network",
    tailnet: "Tailscale",
    relay: "ADE relay",
    ssh: "SSH",
  }[result.route.kind];
  const latency =
    typeof result.route.latencyMs === "number"
      ? ` · ${Math.round(result.route.latencyMs)}ms`
      : "";
  return `Connected via ${routeLabel}${latency}`;
}

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

function joinDiagnosticMessages(
  diagnostics: readonly RemoteRuntimeDiscoveryDiagnostic[],
  severity: RemoteRuntimeDiscoverySeverity,
): string {
  return diagnostics
    .filter((entry) => entry.severity === severity)
    .map((entry) => entry.message)
    .join(" ");
}

const SECTION_LABELS: Record<MachineSection, string> = {
  connected: "Connected",
  available: "Ready to connect",
  unavailable: "Not reachable right now",
};

/** The advice table's sentences are lowercase; a card opens with a capital. */
function capitalizeSentence(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function RemoteTargetList({
  onConnected,
  onDisconnectRequested,
  onRemoveRequested,
  accountMachines,
  accountMachinesState,
  accountSignedIn = false,
  onAccountRequested,
  onAccountMachinesChanged,
  accountEmail = null,
  thisComputerCode = null,
}: RemoteTargetListProps) {
  const [targets, setTargets] = useState<RemoteRuntimeTarget[]>([]);
  const [connectionSnapshot, setConnectionSnapshot] =
    useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const latestConnectionSnapshotUpdatedAtRef = useRef(0);
  const nextLocalConnectionSnapshotUpdatedAt = useCallback(() => {
    const updatedAt = Math.max(
      Date.now(),
      latestConnectionSnapshotUpdatedAtRef.current,
    ) + 1;
    latestConnectionSnapshotUpdatedAtRef.current = updatedAt;
    return updatedAt;
  }, []);
  const [discoveredMachines, setDiscoveredMachines] = useState<
    RemoteRuntimeDiscoveredMachine[]
  >([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState<RemoteRuntimeConnectResult | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadingDiscovered, setLoadingDiscovered] = useState(true);
  const {
    busyById,
    setRowBusy,
    finishRowAction,
    beginConnectAttempt,
    isConnectAttemptCurrent,
    endConnectAttempt,
    dropConnectAttempt,
    trackPairing,
    isPairingInFlight,
  } = useRowActions();
  // An add/edit form submit is in flight. Locks the forms, never the rows.
  const [saving, setSaving] = useState(false);
  const machineUpdates = useMachineUpdates();
  const { attempts: updateResultByTargetId, nowMs: updateClockMs } = machineUpdates;
  const updateSnapshot = useAutoUpdateSnapshot();
  const [trustingHostKey, setTrustingHostKey] = useState(false);
  const [formPrefill, setFormPrefill] =
    useState<RemoteTargetFormPrefill | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One source of truth for what discovery reported; the warning and info lines
  // are derived, so they can never drift out of sync with each other.
  const [discoveryDiagnostics, setDiscoveryDiagnostics] = useState<
    readonly RemoteRuntimeDiscoveryDiagnostic[]
  >([]);
  // A failed `listDiscoveredMachines` call is not a diagnostic the discovery
  // service produced, so it stays its own string rather than a synthetic entry.
  const [discoveryFetchError, setDiscoveryFetchError] = useState<string | null>(null);
  const [hostKeyTrust, setHostKeyTrust] =
    useState<RemoteRuntimeSshHostKeyTrustStatus | null>(null);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [localMachineName, setLocalMachineName] = useState("");
  const [localMachineIdentity, setLocalMachineIdentity] =
    useState<{ machineKey: string; deviceId: string } | null>(null);
  const [pairingPrefill, setPairingPrefill] = useState<string | null>(null);
  const [accountRowErrors, setAccountRowErrors] = useState<
    Record<string, string>
  >({});
  const [accountRowStages, setAccountRowStages] = useState<
    Record<string, string>
  >({});
  const [accountConnectionToasts, setAccountConnectionToasts] = useState<
    Record<string, AccountConnectionToast>
  >({});
  const accountConnectionToastTimers = useRef<
    Map<string, number>
  >(new Map());

  const clearAccountConnectionToast = useCallback((machineKey: string) => {
    const timer = accountConnectionToastTimers.current.get(machineKey);
    if (timer != null) window.clearTimeout(timer);
    accountConnectionToastTimers.current.delete(machineKey);
    setAccountConnectionToasts((current) => {
      if (!(machineKey in current)) return current;
      const next = { ...current };
      delete next[machineKey];
      return next;
    });
  }, []);

  const showAccountConnectionToast = useCallback(
    (machineKey: string, targetId: string, label: string) => {
      const existingTimer =
        accountConnectionToastTimers.current.get(machineKey);
      if (existingTimer != null) window.clearTimeout(existingTimer);
      setAccountConnectionToasts((current) => ({
        ...current,
        [machineKey]: { targetId, label },
      }));
      const timer = window.setTimeout(() => {
        accountConnectionToastTimers.current.delete(machineKey);
        setAccountConnectionToasts((current) => {
          if (!(machineKey in current)) return current;
          const next = { ...current };
          delete next[machineKey];
          return next;
        });
      }, ACCOUNT_CONNECTION_TOAST_MS);
      accountConnectionToastTimers.current.set(machineKey, timer);
    },
    [],
  );

  useEffect(
    () => () => {
      for (const timer of accountConnectionToastTimers.current.values()) {
        window.clearTimeout(timer);
      }
      accountConnectionToastTimers.current.clear();
    },
    [],
  );

  const clearAccountRowStage = useCallback((machineKey: string) => {
    setAccountRowStages((current) => {
      if (!(machineKey in current)) return current;
      const next = { ...current };
      delete next[machineKey];
      return next;
    });
  }, []);

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

  // Which account machines this computer is actually talking to right now.
  // Presence is decided from this rather than from directory heartbeats alone,
  // so a row cannot report a machine we hold a channel to as merely online.
  const connectedIds = useMemo(
    () => connectedMachineIds(connectionSnapshot?.connections),
    [connectionSnapshot],
  );

  // Machines waiting to come back from an update, as a stable key: the clock
  // moves on every render, and the sections only change when this set does.
  const restartingKey = Object.entries(machineUpdates.attempts)
    .filter(([, attempt]) =>
      attempt.pendingVersion != null
      && machineUpdates.nowMs - attempt.startedAtMs < machineUpdateGraceMs(attempt))
    .map(([id, attempt]) => `${id}\t${attempt.pendingVersion}`)
    .sort()
    .join("\n");
  const sections = useMemo(() => {
    const assigned = assignMachineSections({
      targets,
      statusById,
      connectedFallbackId: connected?.target.id ?? null,
      discoveredMachines,
      accountMachines: visibleAccountMachines,
      includeDiscoveredRows: false,
    });
    // A machine restarting for an update drops its connection on purpose.
    // It stays where it was, under Connected, until it is back or the update
    // gives up, instead of jumping to Available with an error.
    const pendingById = new Map(
      (restartingKey ? restartingKey.split("\n") : []).map((entry) => {
        const [id, version] = entry.split("\t");
        return [id, version] as const;
      }),
    );
    // Once the machine reports the new version the update is over, and a
    // later disconnect is an ordinary one.
    const restarting = (row: (typeof assigned.available)[number]): boolean => {
      if (row.kind !== "saved") return false;
      const pending = pendingById.get(row.target.id);
      return pending != null && (!row.version || isMachineVersionOutdated(row.version, pending));
    };
    const moved = [...assigned.available, ...assigned.unavailable].filter(restarting);
    if (moved.length === 0) return assigned;
    return {
      ...assigned,
      connected: [...assigned.connected, ...moved],
      available: assigned.available.filter((row) => !restarting(row)),
      unavailable: assigned.unavailable.filter((row) => !restarting(row)),
    };
  }, [targets, statusById, connected, discoveredMachines, visibleAccountMachines, restartingKey]);

  const loadTargets = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = window.ade.remoteRuntime.getConnectionSnapshot
        ? await window.ade.remoteRuntime.getConnectionSnapshot()
        : null;
      const next = snapshot
        ? snapshot.connections.map((entry) => entry.target)
        : await window.ade.remoteRuntime.listTargets();
      if (
        snapshot &&
        snapshot.updatedAt < latestConnectionSnapshotUpdatedAtRef.current
      ) {
        return;
      }
      if (snapshot) {
        latestConnectionSnapshotUpdatedAtRef.current = snapshot.updatedAt;
        setConnectionSnapshot(snapshot);
      }
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
    const subscribe = window.ade.account?.onPairMachineProgress;
    if (!subscribe) return;
    return subscribe((progress) => {
      setAccountRowStages((current) => ({
        ...current,
        [progress.machineKey]: progress.label,
      }));
    });
  }, []);

  useEffect(() => {
    if (!window.ade.remoteRuntime.onConnectionSnapshotChanged) return;
    const unsubscribe = window.ade.remoteRuntime.onConnectionSnapshotChanged(
      (snapshot) => {
        if (snapshot.updatedAt < latestConnectionSnapshotUpdatedAtRef.current) {
          return;
        }
        latestConnectionSnapshotUpdatedAtRef.current = snapshot.updatedAt;
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
      appVersion: status.version != null ? status.appVersion ?? null : null,
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
      setDiscoveryDiagnostics(next.diagnostics);
      setDiscoveryFetchError(null);
    } catch (err) {
      setDiscoveryDiagnostics([]);
      setDiscoveryFetchError(extractError(err));
    } finally {
      setLoadingDiscovered(false);
    }
  }, []);

  // Warnings mean discovery is degraded and get the warning treatment on the
  // pane itself. Info diagnostics ("Tailscale isn't installed") are normal on a
  // plain machine: they render as muted secondary text with no warning glyph,
  // and only inside Add machine → Nearby, where the reader is actually looking
  // for machines this list could be missing.
  const discoveryError = useMemo(
    () => discoveryFetchError ?? (joinDiagnosticMessages(discoveryDiagnostics, "warning") || null),
    [discoveryDiagnostics, discoveryFetchError],
  );
  const discoveryNote = useMemo(
    () => joinDiagnosticMessages(discoveryDiagnostics, "info") || null,
    [discoveryDiagnostics],
  );

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

  /**
   * Reveals the host-key prompt when this machine's SSH identity still has to
   * be confirmed, and reports which case it is. Returns null when the identity
   * is already trusted and the connect may proceed. A connect that was
   * cancelled while the probe ran reveals nothing.
   */
  const blockingHostKeyTrust = useCallback(
    async (
      targetId: string,
      stillWanted: () => boolean,
    ): Promise<"needs_trust" | "changed" | null> => {
      const status = await window.ade.remoteRuntime.getSshHostKeyTrust(targetId);
      if (!stillWanted()) return null;
      if (status.state === "needs_trust" || status.state === "changed") {
        setHostKeyTrust(status);
        setError(null);
        return status.state;
      }
      setHostKeyTrust((current) =>
        current?.targetId === targetId ? null : current,
      );
      return null;
    },
    [],
  );

  const connectTarget = useCallback(
    async (targetId: string, options: ConnectTargetOptions = {}) => {
      const attempt = beginConnectAttempt(targetId);
      const stillWanted = () => isConnectAttemptCurrent(targetId, attempt);
      setSelectedId(targetId);
      try {
        if (!options.skipHostKeyTrustCheck) {
          const blocked = await blockingHostKeyTrust(targetId, stillWanted);
          if (!stillWanted()) return null;
          if (blocked) {
            options.onTrustRequired?.(blocked);
            return null;
          }
        }
        const result = await window.ade.remoteRuntime.connect(targetId);
        // Cancelled or removed while main was connecting: the snapshot already
        // says what this machine is now, so this late answer is not news.
        if (!stillWanted()) return null;
        const connectedTarget = {
          ...result.target,
          lastConnectedAt: result.target.lastConnectedAt ?? Date.now(),
        };
        setConnected({ ...result, target: connectedTarget });
        setTargets((current) =>
          current.map((target) =>
            target.id === connectedTarget.id ? connectedTarget : target,
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
            target: connectedTarget,
            state: "connected",
            arch: result.arch,
            version: result.version,
            appVersion: result.appVersion ?? null,
            route: result.route,
            capabilities: result.capabilities,
            compatibilityWarnings: result.compatibilityWarnings,
            projects: result.projects,
            lastError: null,
            lastAttemptedAt: Date.now(),
            connectedAt: connectedTarget.lastConnectedAt,
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
            updatedAt: nextLocalConnectionSnapshotUpdatedAt(),
          };
        });
        setSelectedId(result.target.id);
        setHostKeyTrust(null);
        setError(null);
        setTestingId(null);
        onConnected?.(result);
        return result;
      } catch (err) {
        // A cancelled attempt fails by design; that is not an error to show.
        if (!stillWanted()) return null;
        let trustState: "needs_trust" | "changed" | null = null;
        try {
          trustState = await blockingHostKeyTrust(targetId, stillWanted);
        } catch {
          // Preserve the connect failure when a follow-up trust probe also fails.
        }
        if (!stillWanted()) return null;
        if (trustState) {
          options.onTrustRequired?.(trustState);
        } else {
          const message = formatRemoteTargetError(err);
          if (options.onError) options.onError(message);
          else setError(message);
        }
        return null;
      } finally {
        endConnectAttempt(targetId, attempt);
      }
    },
    [
      beginConnectAttempt,
      blockingHostKeyTrust,
      endConnectAttempt,
      isConnectAttemptCurrent,
      nextLocalConnectionSnapshotUpdatedAt,
      onConnected,
      targets,
    ],
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

  const persistTargetAndConnect = useCallback(
    async (
      input: RemoteRuntimeTargetInput,
      replacedTargetId: string | null = null,
    ) => {
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
      }
    },
    [connectTarget],
  );

  const saveTargetAndConnect = useCallback(
    async (
      input: RemoteRuntimeTargetInput,
      replacedTargetId: string | null = null,
    ) => {
      setSaving(true);
      try {
        await persistTargetAndConnect(input, replacedTargetId);
      } finally {
        setSaving(false);
      }
    },
    [persistTargetAndConnect],
  );

  const saveAndConnect = useCallback(
    async (input: RemoteRuntimeTargetInput) => {
      await saveTargetAndConnect(input, formPrefill?.targetId ?? null);
    },
    [formPrefill?.targetId, saveTargetAndConnect],
  );

  const openNearbyPairing = useCallback(
    (machine: RemoteRuntimeDiscoveredMachine): boolean => {
      const directPairingInput = discoveredPairingInput(machine);
      if (!directPairingInput) return false;
      setSelectedId(null);
      setHostKeyTrust(null);
      setError(null);
      setPairingPrefill(directPairingInput);
      setAddMode("pair");
      return true;
    },
    [],
  );

  const connectDiscoveredMachine = useCallback(
    async (machine: RemoteRuntimeDiscoveredMachine) => {
      if (machine.connectable === false) return;
      if (openNearbyPairing(machine)) return;
      if (isSshOnlyDiscovered(machine)) return;
      const input = discoveredTargetInput(machine);
      if (!input) return;
      setRowBusy(machine.id, "connect");
      setSelectedId(null);
      setHostKeyTrust(null);
      setError(null);
      try {
        // Once saved, the machine is a saved row with its own Cancel.
        await persistTargetAndConnect(input);
      } finally {
        setRowBusy(machine.id, null);
      }
    },
    [openNearbyPairing, persistTargetAndConnect, setRowBusy],
  );

  const connectAccountMachine = useCallback(
    async (machine: AdeAccountMachine) => {
      const machineKey = machine.machineKey;
      const rowKey = accountRowKey(machineKey);
      // A cancelled pairing still running in main would race a second one.
      if (isPairingInFlight(rowKey)) return;
      clearAccountConnectionToast(machineKey);
      setAccountRowErrors((current) => {
        if (!(machineKey in current)) return current;
        const next = { ...current };
        delete next[machineKey];
        return next;
      });
      clearAccountRowStage(machineKey);
      const attempt = beginConnectAttempt(rowKey);
      const stillWanted = () => isConnectAttemptCurrent(rowKey, attempt);
      setSelectedId(null);
      setHostKeyTrust(null);
      try {
        // Pairing itself cannot be interrupted; a cancel during it just stops
        // the flow here, leaving the paired machine saved but not connected.
        const paired = await trackPairing(
          rowKey,
          window.ade.account.pairMachine(machineKey),
        );
        if (!stillWanted()) return;
        await loadTargets();
        if (!stillWanted()) return;
        let connectionErrorReported = false;
        const result = await connectTarget(paired.targetId, {
          skipHostKeyTrustCheck: true,
          onError: (message) => {
            connectionErrorReported = true;
            setAccountRowErrors((current) => ({
              ...current,
              [machineKey]: message,
            }));
          },
          onTrustRequired: (state) => {
            connectionErrorReported = true;
            // Show the trust prompt this row was silently blocked on: it only
            // renders for the selected target, and this flow had deselected it.
            setSelectedId(paired.targetId);
            setAccountRowErrors((current) => ({
              ...current,
              [machineKey]: state === "changed"
                ? "This machine's identity has changed since you last connected. Check the fingerprint below before you continue."
                : "This machine hasn't been trusted on this computer yet. Check the fingerprint below, then continue.",
            }));
          },
        });
        if (!stillWanted()) return;
        if (!result) {
          if (!connectionErrorReported) {
            setAccountRowErrors((current) => ({
              ...current,
              [machineKey]: "ADE couldn't finish opening the connection, and didn't say why. Try again — if it keeps happening, check that ADE is running on that machine.",
            }));
          }
          return;
        }
        const label = connectedViaLabel(result);
        if (label) {
          showAccountConnectionToast(
            machineKey,
            result.target.id,
            label,
          );
        }
      } catch (err) {
        if (!stillWanted()) return;
        setAccountRowErrors((current) => ({
          ...current,
          [machineKey]: formatRemoteTargetError(err),
        }));
      } finally {
        // A cancelled attempt was already cleaned up by the cancel, and a newer
        // attempt on this machine owns the row state now.
        if (stillWanted()) {
          clearAccountRowStage(machineKey);
          endConnectAttempt(rowKey, attempt);
        }
      }
    },
    [
      beginConnectAttempt,
      clearAccountConnectionToast,
      clearAccountRowStage,
      connectTarget,
      endConnectAttempt,
      isConnectAttemptCurrent,
      isPairingInFlight,
      loadTargets,
      showAccountConnectionToast,
      trackPairing,
    ],
  );

  const onPaired = useCallback(
    async (targetId: string) => {
      await loadTargets();
      const connectedOk = await connectTarget(targetId);
      if (connectedOk) setAddMode(null);
    },
    [connectTarget, loadTargets],
  );

  /** Shows the target as idle right away, ahead of main's snapshot event. */
  const markTargetIdle = useCallback(
    (targetId: string) => {
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
          updatedAt: nextLocalConnectionSnapshotUpdatedAt(),
        };
      });
    },
    [nextLocalConnectionSnapshotUpdatedAt],
  );

  /**
   * Stops this computer's attempts on a machine: the renderer flows that are
   * still running for it (a target connect, an account pairing) drop out
   * without reporting, and nothing else in the list is touched.
   */
  const abandonConnectAttempts = useCallback(
    (targetId: string | null, machineKey: string | null) => {
      if (targetId) dropConnectAttempt(targetId);
      if (machineKey) {
        dropConnectAttempt(accountRowKey(machineKey));
        clearAccountRowStage(machineKey);
      }
      if (targetId) {
        setHostKeyTrust((current) =>
          current?.targetId === targetId ? null : current,
        );
      }
    },
    [clearAccountRowStage, dropConnectAttempt],
  );

  /**
   * Cancel on a connecting or reconnecting row. Main's disconnect invalidates
   * the in-flight connect for this target only, and marking it manual keeps
   * automatic reconnect from starting it again behind the user's back; an
   * explicit Connect clears that again.
   */
  const cancelConnect = useCallback(
    async (targetId: string | null, machineKey: string | null) => {
      abandonConnectAttempts(targetId, machineKey);
      if (!targetId) return;
      setRowBusy(targetId, "cancel");
      try {
        await window.ade.remoteRuntime.disconnect(targetId, { manual: true });
        markTargetIdle(targetId);
      } catch (err) {
        setError(formatRemoteTargetError(err));
      } finally {
        finishRowAction(targetId, "cancel");
      }
    },
    [abandonConnectAttempts, finishRowAction, markTargetIdle, setRowBusy],
  );

  const disconnectTarget = useCallback(
    async (targetId: string) => {
      const target = targets.find((entry) => entry.id === targetId) ?? null;
      if (target && onDisconnectRequested) {
        const shouldDisconnect = await onDisconnectRequested(target);
        if (!shouldDisconnect) return;
      }
      setRowBusy(targetId, "disconnect");
      setSelectedId(targetId);
      try {
        await window.ade.remoteRuntime.disconnect(targetId, { manual: true });
        markTargetIdle(targetId);
        setError(null);
        setHostKeyTrust(null);
      } catch (err) {
        setError(formatRemoteTargetError(err));
      } finally {
        finishRowAction(targetId, "disconnect");
      }
    },
    [finishRowAction, markTargetIdle, onDisconnectRequested, setRowBusy, targets],
  );

  const removeTarget = useCallback(
    async (targetId: string) => {
      const target = targets.find((entry) => entry.id === targetId) ?? null;
      if (target && onRemoveRequested) {
        const shouldRemove = await onRemoveRequested(target);
        if (!shouldRemove) return;
      }
      // Removing a machine that is still connecting cancels that attempt
      // first: the renderer flow drops out here, and main's removeTarget
      // disconnects the target (ending its in-flight connect) before deleting.
      abandonConnectAttempts(
        targetId,
        target?.pairedMachine?.machineKey ?? null,
      );
      setRowBusy(targetId, "remove");
      try {
        await window.ade.remoteRuntime.removeTarget(targetId);
        setTargets((current) =>
          current.filter((entry) => entry.id !== targetId),
        );
        setConnected((current) =>
          current?.target.id === targetId ? null : current,
        );
        if (selectedId === targetId) setSelectedId(null);
        if (formPrefill?.targetId === targetId) setFormPrefill(null);
        if (testingId === targetId) setTestingId(null);
        setError(null);
      } catch (err) {
        setError(formatRemoteTargetError(err));
      } finally {
        setRowBusy(targetId, null);
      }
    },
    [
      abandonConnectAttempts,
      formPrefill?.targetId,
      onRemoveRequested,
      selectedId,
      setRowBusy,
      targets,
      testingId,
    ],
  );

  const setTargetAutoConnect = useCallback(async (targetId: string, enabled: boolean) => {
    setRowBusy(targetId, "autoConnect");
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
            updatedAt: nextLocalConnectionSnapshotUpdatedAt(),
          }
        : current);
      setError(null);
    } catch (err) {
      setError(formatRemoteTargetError(err));
    } finally {
      setRowBusy(targetId, null);
    }
  }, [nextLocalConnectionSnapshotUpdatedAt, setRowBusy]);

  const totalRows =
    sections.connected.length +
    sections.available.length +
    sections.unavailable.length;

  // "The account list did not arrive" — distinct from "the account has none".
  // Signed-out / expired already have a header line; don't repeat it here.
  const accountMachinesLoadFailed = Boolean(
    accountSignedIn
    && accountMachinesState
    && accountMachinesState !== "ok"
    && accountMachinesState !== "signed_out",
  );

  const nearbyPairingByAccountMachineKey = useMemo(() => {
    const matches = new Map<string, RemoteRuntimeDiscoveredMachine>();
    for (const accountMachine of visibleAccountMachines ?? []) {
      const discovered = discoveredMachines.find(
        (machine) =>
          accountMachineMatchesNearby(accountMachine, machine) &&
          discoveredPairingInput(machine) != null,
      );
      if (discovered) matches.set(accountMachine.machineKey, discovered);
    }
    return matches;
  }, [discoveredMachines, visibleAccountMachines]);

  // A saved paired target that is also on this ADE account can be re-adopted
  // from the directory — that is what "Pair again" runs when a machine rejects
  // the stale pairing. Without a directory match there is nothing to re-adopt.
  const accountMachineForTarget = useCallback(
    (target: RemoteRuntimeTarget): AdeAccountMachine | null =>
      (visibleAccountMachines ?? []).find((machine) =>
        accountMachineMatchesTarget(machine, target),
      ) ?? null,
    [visibleAccountMachines],
  );

  const accountToastByTargetId = useMemo(() => {
    const labels = new Map<string, string>();
    for (const toast of Object.values(accountConnectionToasts)) {
      labels.set(toast.targetId, toast.label);
    }
    return labels;
  }, [accountConnectionToasts]);

  // The newest ADE this computer knows about — what it runs today, or a newer
  // build it has already seen published. A connected machine behind that gets
  // the "Update & restart" button; a machine that is level with us gets none.
  const newestKnownVersion = useMemo(
    () =>
      newestKnownAdeVersion({
        currentVersion: updateSnapshot.currentVersion,
        latestKnownVersion: updateSnapshot.latestKnownVersion,
      }),
    [updateSnapshot.currentVersion, updateSnapshot.latestKnownVersion],
  );

  function renderSection(section: MachineSection) {
    const rows = sections[section];
    if (rows.length === 0) return null;
    // Connected machines behind the newest ADE this computer knows about.
    const behindMachines = section === "connected"
      ? outdatedMachines(
          rows.flatMap((row) =>
            row.kind === "saved" && row.connected
              ? [{ id: row.target.id, name: row.target.name, version: row.version, versionLabel: row.versionLabel }]
              : []),
          newestKnownVersion,
        )
      : [];
    const updateAllBusy = behindMachines.some((machine) =>
      isMachineUpdateBusy(machineUpdates, machine, machineUpdates.nowMs));
    return (
      <div className="ade-cx-section">
        {behindMachines.length > 1 ? (
          <MachinesBehindBanner
            count={behindMachines.length}
            targetVersion={newestKnownVersion}
            busy={updateAllBusy}
            onUpdateAll={() => void requestMachineUpdates(behindMachines, newestKnownVersion)}
          />
        ) : null}
        <div className="ade-cx-section-head">
          {SECTION_LABELS[section]}
          <span className="ade-cx-count">{rows.length}</span>
        </div>
        <div className="ade-cx-list">
        {rows.map((row) => {
          if (row.kind === "saved") {
            const pairAgainMachine = accountMachineForTarget(row.target);
            const pairedMachineKey = row.target.pairedMachine?.machineKey ?? null;
            const rowAction = busyById[row.target.id] ?? null;
            // An account pairing for this machine ("Pair again") counts too.
            const pairingThisMachine =
              pairedMachineKey != null &&
              busyById[accountRowKey(pairedMachineKey)] === "connect";
            const rowConnecting = rowAction === "connect" || pairingThisMachine;
            // A cancelled pairing still finishing in main locks Connect and
            // "Pair again" here too; either would race it.
            const pairingStopping =
              pairedMachineKey != null &&
              busyById[accountRowKey(pairedMachineKey)] === "stopping";
            const updateAttempt = updateResultByTargetId[row.target.id] ?? null;
            const updateStatus = updateAttempt
              ? describeMachineUpdateAttempt(updateAttempt, row, updateClockMs)
              : null;
            const updatePhase = machineUpdatePhase({
              checking: machineUpdates.checkingIds.has(row.target.id),
              sending: machineUpdates.updatingIds.has(row.target.id),
              status: updateStatus,
            });
            return (
              <SavedMachineRow
                key={row.id}
                row={row}
                section={section}
                selected={selectedId === row.target.id}
                connected={connected}
                connecting={rowConnecting}
                busy={
                  (rowAction != null && rowAction !== "connect") ||
                  pairingStopping
                }
                saving={saving}
                formPrefill={formPrefill}
                testOpen={testingId === row.target.id}
                error={
                  (row.target.pairedMachine?.machineKey
                    ? accountRowErrors[
                        row.target.pairedMachine.machineKey
                      ] ?? null
                    : null) ?? error
                }
                stageLabel={
                  pairedMachineKey && pairingThisMachine
                    ? accountRowStages[pairedMachineKey] ?? null
                    : null
                }
                transientStatus={
                  accountToastByTargetId.get(row.target.id) ?? null
                }
                updateTargetVersion={
                  updatePhase && updateAttempt?.pendingVersion
                    ? updateAttempt.pendingVersion
                    : row.connected &&
                        isMachineVersionOutdated(row.version, newestKnownVersion)
                      ? newestKnownVersion
                      : null
                }
                updatePhase={updatePhase}
                power={pairAgainMachine?.power ?? null}
                updating={machineUpdates.updatingIds.has(row.target.id) || updateStatus?.inFlight === true}
                checkingUpdate={machineUpdates.checkingIds.has(row.target.id)}
                updateStatus={updateStatus ? { ok: updateStatus.ok, message: updateStatus.message } : null}
                onUpdateAndRestart={(targetVersion) =>
                  void requestMachineUpdates(
                    [{ id: row.target.id, name: row.target.name, version: row.version, versionLabel: row.versionLabel }],
                    targetVersion,
                  )
                }
                hostKeyTrust={
                  selectedId === row.target.id ? selectedHostKeyTrust : null
                }
                trustingHostKey={trustingHostKey}
                onConnect={(targetId) => {
                  const machineKey = row.target.pairedMachine?.machineKey;
                  if (machineKey) {
                    setAccountRowErrors((current) => {
                      if (!(machineKey in current)) return current;
                      const next = { ...current };
                      delete next[machineKey];
                      return next;
                    });
                  }
                  void connectTarget(targetId);
                }}
                onDisconnect={(targetId) => void disconnectTarget(targetId)}
                onToggleTest={toggleTest}
                onToggleEdit={toggleEditForm}
                onRemove={(targetId) => void removeTarget(targetId)}
                onCancelConnect={(targetId) =>
                  void cancelConnect(targetId, pairedMachineKey)
                }
                onSaveAndConnect={saveAndConnect}
                onAutoConnectChange={(targetId, enabled) => {
                  void setTargetAutoConnect(targetId, enabled);
                }}
                onTrustAndConnect={() => void trustAndConnect()}
                onCancelHostKeyTrust={() => setHostKeyTrust(null)}
                onPairAgain={pairAgainMachine
                  ? () => void connectAccountMachine(pairAgainMachine)
                  : null}
              />
            );
          }
          if (row.kind === "account") {
            return (
              <AccountMachineRow
                key={row.id}
                row={row}
                section={section}
                busy={busyById[accountRowKey(row.machine.machineKey)] != null}
                connecting={
                  busyById[accountRowKey(row.machine.machineKey)] === "connect"
                }
                connected={isMachineConnected(row.machine, connectedIds)}
                error={accountRowErrors[row.machine.machineKey] ?? null}
                errorInfo={
                  row.matchedTargetId
                    ? statusById.get(row.matchedTargetId)?.lastErrorInfo ?? null
                    : null
                }
                stageLabel={accountRowStages[row.machine.machineKey] ?? null}
                successLabel={
                  accountConnectionToasts[row.machine.machineKey]?.label ?? null
                }
                onPairNearby={
                  nearbyPairingByAccountMachineKey.has(row.machine.machineKey)
                    ? () => {
                        const machine = nearbyPairingByAccountMachineKey.get(
                          row.machine.machineKey,
                        );
                        if (!machine) return;
                        setAccountRowErrors((current) => {
                          if (!(row.machine.machineKey in current)) {
                            return current;
                          }
                          const next = { ...current };
                          delete next[row.machine.machineKey];
                          return next;
                        });
                        openNearbyPairing(machine);
                      }
                    : null
                }
                detailOpen={testingId === row.id}
                onToggleDetail={toggleTest}
                onConnect={(machine) => void connectAccountMachine(machine)}
                onCancelConnect={(machine) =>
                  void cancelConnect(row.matchedTargetId, machine.machineKey)
                }
                onRenamed={onAccountMachinesChanged}
              />
            );
          }
          return (
            <DiscoveredMachineRow
              key={row.id}
              machine={row.machine}
              section={section}
              busy={busyById[row.machine.id] != null}
              testOpen={testingId === row.machine.id}
              onConnect={(machine) => void connectDiscoveredMachine(machine)}
              onToggleTest={toggleTest}
            />
          );
        })}
        </div>
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
    if (next === "nearby") void loadDiscoveredMachines();
    setAddMode(next);
  }, [loadDiscoveredMachines]);

  const startAdd = useCallback((mode: AddMode) => {
    setSelectedId(null);
    setFormPrefill(null);
    setError(null);
    setHostKeyTrust(null);
    setPairingPrefill(null);
    if (mode === "nearby") void loadDiscoveredMachines();
    setAddMode(mode);
  }, [loadDiscoveredMachines]);
  const openAddMachine = useCallback(() => {
    if (addMode) setAddMode(null);
    else startAdd("choose");
  }, [addMode, startAdd]);

  // The other ways in, after the account (which the sheet leads with).
  const otherWays: Array<{
    key: Exclude<AddMode, "choose" | "pair">;
    icon: ReactNode;
    label: string;
    detail: string;
  }> = [
    {
      key: "nearby",
      icon: <WifiHigh size={18} weight="bold" />,
      label: "Find nearby",
      detail: "Computers on this Wi-Fi with ADE open",
    },
    ...(thisComputerCode
      ? [{
          key: "code" as const,
          icon: <Key size={18} weight="bold" />,
          label: "Pairing code",
          detail: "Let a phone or another computer connect here",
        }]
      : []),
    {
      key: "ssh",
      icon: <TerminalWindow size={18} weight="bold" />,
      label: "SSH",
      detail: "Advanced: an address and a private key",
    },
  ];

  const addTitle: Record<AddMode, string> = {
    choose: "Add a computer",
    nearby: "Find nearby computers",
    pair: "Pair with a nearby computer",
    ssh: "Add over SSH",
    code: "This computer's pairing code",
  };

  const showEmptyState = !loading
    && !loadingDiscovered
    && totalRows === 0
    && !accountMachinesLoadFailed
    && !addMode;

  return (
    <div style={panelStyle}>
      <div style={{ display: "grid", gap: 12 }}>
        <div className="ade-cx-list-head">
          <span className="ade-cx-list-title">Your computers</span>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <button
              type="button"
              aria-label="Refresh"
              title="Look for computers again"
              disabled={loadingDiscovered}
              onClick={() => void loadDiscoveredMachines()}
              className="ade-cx-icon-btn"
            >
              <ArrowClockwise size={14} weight="bold" className={loadingDiscovered ? "animate-spin" : undefined} />
            </button>
            <button
              type="button"
              aria-label="Add machine"
              onClick={openAddMachine}
              aria-expanded={addMode != null}
              className="ade-cx-add-btn"
            >
              <Plus size={13} weight="bold" />
              Add computer
            </button>
          </div>
        </div>

        {addMode ? (
          <div className="ade-cx-add">
            <div className="ade-cx-add-head">
              {addMode !== "choose" ? (
                <button
                  type="button"
                  aria-label="Back to Add a computer"
                  onClick={() => setAddMode("choose")}
                  className="ade-cx-icon-btn"
                >
                  <CaretLeft size={14} weight="bold" />
                </button>
              ) : null}
              <span className="ade-cx-add-title">{addTitle[addMode]}</span>
              <button
                type="button"
                aria-label="Close Add a computer"
                onClick={() => setAddMode(null)}
                className="ade-cx-icon-btn"
              >
                <X size={14} weight="bold" />
              </button>
            </div>

            {addMode === "choose" ? (
              <>
                {accountSignedIn ? (
                  <div className="ade-cx-steps-card">
                    <div className="ade-cx-steps-title">
                      <span className="ade-cx-recommended">Recommended</span>
                      Sign in on your other computer
                    </div>
                    <ol className="ade-cx-steps">
                      <li>
                        <span className="ade-cx-step-num">1</span>
                        <span className="ade-cx-step-copy">
                          <b>Install ADE</b> on the other computer.
                        </span>
                        <button type="button" className="ade-cx-chip-btn" onClick={() => openExternalUrl(ADE_SITE_URL)}>
                          Get ADE
                          <ArrowSquareOut size={11} weight="bold" />
                        </button>
                      </li>
                      <li>
                        <span className="ade-cx-step-num">2</span>
                        <span className="ade-cx-step-copy">
                          <b>Sign in</b> there{accountEmail ? <> as <span className="ade-cx-email">{accountEmail}</span></> : " with this same ADE account"}.
                        </span>
                      </li>
                      <li>
                        <span className="ade-cx-step-num">3</span>
                        <span className="ade-cx-step-copy">
                          It shows up in this list. Press <b>Connect</b>.
                        </span>
                      </li>
                    </ol>
                  </div>
                ) : (
                  <button type="button" className="ade-cx-steps-card ade-cx-signin" onClick={() => onAccountRequested?.()}>
                    <span className="ade-cx-way-icon" data-tone="accent"><UserCircle size={20} weight="bold" /></span>
                    <span className="ade-cx-way-copy">
                      <span className="ade-cx-way-label">Sign in to ADE</span>
                      <span className="ade-cx-way-detail">The easiest way: your computers find each other on your account.</span>
                    </span>
                    <CaretRight size={14} weight="bold" />
                  </button>
                )}
                <div className="ade-cx-or">Or connect another way</div>
                <div className="ade-cx-ways">
                  {otherWays.map((way) => (
                    <button key={way.key} type="button" className="ade-cx-way" onClick={() => chooseAddMode(way.key)}>
                      <span className="ade-cx-way-icon">{way.icon}</span>
                      <span className="ade-cx-way-label">{way.label}</span>
                      <span className="ade-cx-way-detail">{way.detail}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {addMode === "code" ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div style={helperTextStyle}>
                  In ADE on the phone or the other computer, choose to pair with a code and enter this one. Computers signed in to your account don't need it.
                </div>
                {thisComputerCode}
              </div>
            ) : null}
            {addMode === "pair" ? (
              <PairMachineForm
                defaultDeviceName={localMachineName}
                initialInput={pairingPrefill}
                busy={saving}
                onPaired={onPaired}
              />
            ) : null}
            {addMode === "ssh" ? (
              <RemoteTargetForm
                busy={saving}
                submitLabel="Connect"
                onSubmit={saveAndConnect}
              />
            ) : null}
            {addMode === "nearby" ? (
              <div style={{ display: "grid", gap: 8 }}>
                {loadingDiscovered ? (
                  <div className="ade-cx-scanning">
                    <CircleNotch size={14} weight="bold" className="animate-spin" />
                    Looking for computers on this network…
                  </div>
                ) : null}
                {!loadingDiscovered && nearbyMachines.length === 0 ? (
                  <div style={helperTextStyle}>
                    No computers found. Open ADE on the other computer and make sure both are on the same Wi-Fi or Tailscale network.
                  </div>
                ) : null}
                {/* Info diagnostics ("Tailscale isn't installed") explain what is
                    missing from *this* list, so they belong here rather than on
                    the resting pane. */}
                {discoveryNote ? <div style={helperTextStyle}>{discoveryNote}</div> : null}
                {nearbyMachines.length > 0 ? (
                  <div className="ade-cx-list">
                    {nearbyMachines.map((machine) => (
                      <DiscoveredMachineRow
                        key={machine.id}
                        machine={machine}
                        section={machine.connectable === false ? "unavailable" : "available"}
                        busy={busyById[machine.id] != null}
                        testOpen={testingId === machine.id}
                        onConnect={(next) => void connectDiscoveredMachine(next)}
                        onToggleTest={toggleTest}
                      />
                    ))}
                  </div>
                ) : null}
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

        {accountMachinesLoadFailed ? (
          <div style={helperTextStyle}>
            {accountMachinesState === "not_configured"
              ? "Account computers aren't available yet. Saved and nearby computers still work."
              : "Couldn't load machines from your account. Saved and nearby machines still work."}
          </div>
        ) : null}

        {/* Only claim the account is empty when we actually know it is: a failed
            account fetch leaves `totalRows` at 0 too. */}
        {showEmptyState ? (
          <div className="ade-cx-empty">
            <div className="ade-cx-empty-art" aria-hidden>
              <span className="ade-cx-empty-device"><Desktop size={22} weight="duotone" /></span>
              <span className="ade-cx-empty-link"><PlugsConnected size={14} weight="bold" /></span>
              <span className="ade-cx-empty-device" data-dashed><Laptop size={22} weight="duotone" /></span>
            </div>
            <div className="ade-cx-empty-title">Connect your other computers</div>
            <div className="ade-cx-empty-detail">
              Run chats and terminals on another machine from this window. Lanes stay on the computer that has them.
            </div>
            <div className="ade-cx-empty-actions">
              <button type="button" className="ade-cx-add-btn" data-size="lg" onClick={() => startAdd("choose")}>
                <Plus size={13} weight="bold" />
                Add a computer
              </button>
              <button type="button" className="ade-cx-ghost-btn" onClick={() => startAdd("nearby")}>
                <WifiHigh size={13} weight="bold" />
                Find nearby
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
