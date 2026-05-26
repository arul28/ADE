import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import RFB from "@novnc/novnc";
import {
  ArrowClockwise,
  ArrowsInSimple,
  ArrowsOutSimple,
  DesktopTower,
  DownloadSimple,
  GitBranch,
  Play,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  LaneSummary,
  MacosVmDownloadProgress,
  MacosVmEventPayload,
  MacosVmLifecycleState,
  MacosVmPhaseNumber,
  MacosVmRecord,
  MacosVmRuntimeInstallStatus,
  MacosVmStatus,
  MacosVmStorageInfo,
  MacosVmStoredCredentialsSummary,
  MacosVmToolStatus,
} from "../../../shared/types";
import { MACOS_VM_PHASES } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import {
  fallbackMacosVmGuestReadiness,
  macosVmPhaseFromReadiness,
  macosVmPhaseLabel,
} from "../../lib/macosVmRuntimeReadiness";
import { CurrentVmLaneRow } from "./CurrentVmLaneRow";
import { CredentialsPromptDialog } from "./CredentialsPromptDialog";
import { FirstBootCard, FIRST_BOOT_STEPS } from "./FirstBootCard";
import { MacMiniGlyph } from "./MacMiniGlyph";
import { ProductionMacVmComingSoon } from "./MacVmComingSoon";
import { PhaseDescriptor, PhaseStepper, PhaseStatus } from "./PhaseStepper";
import { VmLifecycleMenu } from "./VmLifecycleMenu";

const DISPLAY_CONNECT_TIMEOUT_MS = 12_000;
const TRANSIENT_STATES: ReadonlySet<MacosVmLifecycleState> = new Set([
  "creating",
  "installing",
  "starting",
  "stopping",
]);

type Message = { tone: "info" | "error"; text: string } | null;

function stateLabel(value: string | null | undefined): string {
  if (!value) return "Not created";
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function pickActiveVm(status: MacosVmStatus | null): MacosVmRecord | null {
  if (!status?.vms.length) return null;
  return status.vms.find((vm) => vm.state === "running") ?? status.vms[0] ?? null;
}

function lifecycleToneColor(state: MacosVmLifecycleState | null | undefined): string {
  if (state === "running") return "var(--color-success, #34d399)";
  if (state === "failed") return "var(--color-error, #ef4444)";
  if (state === "paused") return "var(--color-info, #3b82f6)";
  if (state && TRANSIENT_STATES.has(state)) return "var(--color-accent, #A78BFA)";
  return "var(--color-warning, #fbbf24)";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const formatted = value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[i]}`;
}

function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return secs ? `${minutes}m ${secs}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function StatusPill({
  state,
  transient,
  label,
}: {
  state: MacosVmLifecycleState | null | undefined;
  transient: boolean;
  label?: string;
}) {
  const color = lifecycleToneColor(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px]",
        transient && "ade-vm-pill-pulse",
      )}
      style={{
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px 1px color-mix(in srgb, ${color} 45%, transparent)` }}
        aria-hidden
      />
      <span
        className="font-mono text-[10px] font-bold uppercase tracking-[1px]"
        style={{ color: "#FAFAFA" }}
      >
        {label ?? stateLabel(state)}
      </span>
    </span>
  );
}

function DownloadDetail({ progress }: { progress: MacosVmDownloadProgress }) {
  const total = progress.totalBytes && progress.totalBytes > 0 ? progress.totalBytes : null;
  const pct = total ? Math.min(100, (progress.downloadedBytes / total) * 100) : null;
  const sourceLabel = progress.source === "ipsw" ? "macOS restore image (IPSW)" : "ADE agent runtime";
  // When the IPSW download is complete the backend is in `lume create`
  // installing macOS into the VM disk — a separate ~10–30 min step that the
  // current lifecycle model still reports as "provisioning" (i.e. phase 2).
  // Surface that explicitly so the user doesn't think the install is stuck.
  const downloadComplete = progress.source === "ipsw" && total != null && progress.downloadedBytes >= total;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]" style={{ color: "#D4D4D8" }}>
        <span className="font-semibold" style={{ color: "#FAFAFA" }}>{sourceLabel}</span>
        <span data-testid="download-bytes">
          {formatBytes(progress.downloadedBytes)} / {total ? formatBytes(total) : "?"}
        </span>
        {pct != null ? (
          <span data-testid="download-percent">{pct.toFixed(1)}%</span>
        ) : null}
        {!downloadComplete ? (
          <span data-testid="download-eta">
            ETA {formatEta(progress.etaSeconds)}
          </span>
        ) : null}
      </div>
      <div
        className="relative h-2 overflow-hidden rounded-full"
        style={{ background: "#1A1622", border: "1px solid #2A2535" }}
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-300"
          style={{
            width: pct != null ? `${pct}%` : "20%",
            background: downloadComplete
              ? "linear-gradient(90deg, #34d399 0%, #6ee7b7 100%)"
              : "linear-gradient(90deg, #7B61FF 0%, #A78BFA 100%)",
          }}
        />
      </div>
      {downloadComplete ? (
        <div
          className="rounded-md px-2.5 py-1.5 text-[11px] leading-5"
          style={{
            background: "#13101A",
            border: "1px solid #1E1B26",
            color: "#D4D4D8",
          }}
        >
          <div className="mb-0.5 flex items-center gap-1.5 font-semibold" style={{ color: "#FAFAFA" }}>
            <SpinnerGap size={11} className="animate-spin" style={{ color: "#A78BFA" }} />
            Installing macOS via Lume
          </div>
          <div style={{ color: "#A1A1AA" }}>
            Download is complete. ADE is now installing macOS into the VM disk
            (~10–30 min). The stepper will advance to <span style={{ color: "#D4D4D8" }}>Boot</span>{" "}
            once Lume finishes. You can switch tabs.
          </div>
        </div>
      ) : (
        <div className="text-[11px]" style={{ color: "#A1A1AA" }}>
          You can switch tabs. Keep ADE open.
        </div>
      )}
    </div>
  );
}

function RuntimeInstallDetail({ status }: { status: MacosVmRuntimeInstallStatus }) {
  if (status.state === "installed") {
    return <span className="text-[11px]" style={{ color: "#A1A1AA" }}>Agent runtime installed.</span>;
  }
  if (status.state === "failed") {
    return (
      <span className="text-[11px]" style={{ color: "var(--color-error, #ef4444)" }}>
        {status.lastError ?? status.detail ?? "Runtime install failed."}
      </span>
    );
  }
  if (status.state === "installing") {
    return (
      <span className="inline-flex items-center gap-2 text-[11px]" style={{ color: "#A1A1AA" }}>
        <SpinnerGap size={11} className="animate-spin" style={{ color: "#A78BFA" }} />
        {status.detail || "Installing the ADE agent runtime inside the VM."}
      </span>
    );
  }
  return <span className="text-[11px]" style={{ color: "#A1A1AA" }}>{status.detail || "Runtime install will start when the VM is ready."}</span>;
}

type AppPackagingState = "checking" | "packaged" | "dev";

/**
 * Gate the Mac VM tab behind a "Coming soon" splash in packaged builds —
 * mirrors the production-gate pattern. The provisioning + first-boot
 * flow still lives in {@link MacVmWorkspace} and runs unchanged in dev.
 *
 * The `getInfo()` call is guarded so existing renderer tests that stub
 * `window.ade.app` without `getInfo` simply fall through to dev mode
 * instead of throwing.
 */
function MacVmProductionGate({ children }: { children: React.ReactElement }) {
  const [state, setState] = useState<AppPackagingState>("checking");

  useEffect(() => {
    let cancelled = false;
    let probe: Promise<{ isPackaged: boolean }> | null = null;
    try {
      const getInfo = window.ade?.app?.getInfo;
      probe = typeof getInfo === "function" ? getInfo() : null;
    } catch {
      probe = null;
    }
    if (!probe) {
      setState("dev");
      return () => {
        cancelled = true;
      };
    }
    probe.then(
      (info) => {
        if (!cancelled) setState(info.isPackaged ? "packaged" : "dev");
      },
      () => {
        if (!cancelled) setState("dev");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex h-full min-w-0 flex-col" style={{ background: "#0C0A10" }}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div
            className="h-4 w-48 animate-pulse rounded-md"
            style={{ background: "rgba(255,255,255,0.06)" }}
          />
          <div
            className="font-mono text-[10px] font-bold uppercase tracking-widest"
            style={{ color: "#71717A" }}
          >
            Checking VM availability...
          </div>
        </div>
      </div>
    );
  }

  if (state === "packaged") return <ProductionMacVmComingSoon />;

  return children;
}

export function MacVmPage() {
  return (
    <MacVmProductionGate>
      <MacVmWorkspace />
    </MacVmProductionGate>
  );
}

function MacVmWorkspace() {
  const navigate = useNavigate();
  const setMacosVmTabIndicator = useAppStore((s) => s.setMacosVmTabIndicator);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const displayContainerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);

  const [status, setStatus] = useState<MacosVmStatus | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState<
    | "refresh"
    | "setup"
    | "restart"
    | "wipe"
    | "force-stop"
    | "install-runtime"
    | "detach"
    | "save-credentials"
    | null
  >(null);
  const [displayMessage, setDisplayMessage] = useState<string | null>(null);
  const [displayConnected, setDisplayConnected] = useState(false);
  const [download, setDownload] = useState<MacosVmDownloadProgress | null>(null);
  const [runtimeInstall, setRuntimeInstall] = useState<MacosVmRuntimeInstallStatus | null>(null);
  const [compactMode, setCompactMode] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [credentials, setCredentials] = useState<MacosVmStoredCredentialsSummary | null>(null);
  const [firstBootStepIndex, setFirstBootStepIndex] = useState(0);
  const [consoleExpanded, setConsoleExpanded] = useState(false);
  const [manualCleanupPaths, setManualCleanupPaths] = useState<string[] | null>(null);
  const [setupPreflight, setSetupPreflight] = useState<MacosVmStorageInfo | null>(null);

  const activeVm = useMemo(() => pickActiveVm(status), [status]);
  const guestReadiness = useMemo(() => fallbackMacosVmGuestReadiness(activeVm), [activeVm]);
  const phaseNumber: MacosVmPhaseNumber = useMemo(
    () => macosVmPhaseFromReadiness(activeVm, guestReadiness),
    [activeVm, guestReadiness],
  );
  const attachedVmLane = useMemo<LaneSummary | null>(
    () => lanes.find((lane) => lane.runtimePlacement === "macos-vm" && !lane.archivedAt) ?? null,
    [lanes],
  );

  const supported = status?.supported === true;
  const providerReady = status?.activeProvider.available === true;
  const lumeToolStatus = useMemo(
    () => status?.tools.find((tool) => tool.name === "lume") ?? null,
    [status?.tools],
  );
  const transient = Boolean(activeVm?.state && TRANSIENT_STATES.has(activeVm.state));
  const running = activeVm?.state === "running";
  const failed = activeVm?.state === "failed";
  const sshAvailable = guestReadiness.sshAvailable === true;
  const hasVm = Boolean(activeVm);
  const phaseTen = phaseNumber === 10;

  const downloadProgress = download ?? activeVm?.downloadProgress ?? null;
  const runtimeStatus = runtimeInstall ?? activeVm?.runtimeInstall ?? null;

  const refresh = useCallback(async (announce = false) => {
    setBusy((current) => current ?? "refresh");
    try {
      const next = await window.ade.macosVm.getStatus({});
      setStatus(next);
      if (announce) setMessage({ tone: "info", text: "VM status refreshed." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy((current) => (current === "refresh" ? null : current));
    }
  }, []);

  // Initial load + IPC event subscription.
  useEffect(() => {
    void refreshLanes({ includeStatus: false });
    void refresh(false);
    const unsubscribe = window.ade.macosVm.onEvent((event: MacosVmEventPayload) => {
      switch (event.type) {
        case "status":
          setStatus(event.status);
          break;
        case "vm-updated":
          setStatus((current) =>
            current
              ? {
                ...current,
                vms: [
                  event.vm,
                  ...current.vms.filter((entry) => entry.id !== event.vm.id),
                ],
                laneVm: current.laneVm?.laneId === event.vm.laneId ? event.vm : current.laneVm,
              }
              : current,
          );
          break;
        case "operation":
          setMessage({
            tone: event.state === "failed" ? "error" : "info",
            text: event.message,
          });
          break;
        case "download-progress":
          setDownload(event.progress);
          break;
        case "phase-changed":
          // Status update follows; nothing to do beyond letting refresh propagate.
          break;
        case "runtime-install":
          setRuntimeInstall(event.status);
          break;
        case "resume-available":
          setMessage({
            tone: "info",
            text: `Resumable download detected (${formatBytes(event.bytesAvailable)} cached). It will pick up where it left off.`,
          });
          break;
      }
    });
    return unsubscribe;
  }, [refresh, refreshLanes]);

  // Compact mode auto-engages when phase 10 is reached.
  useEffect(() => {
    setCompactMode(phaseTen);
  }, [phaseTen]);

  // Sync stored credentials summary when the VM identity changes.
  useEffect(() => {
    if (!activeVm?.name) {
      setCredentials(null);
      return;
    }
    let cancelled = false;
    window.ade.macosVm
      .getCredentials({ vmName: activeVm.name })
      .then((summary) => {
        if (!cancelled) setCredentials(summary);
      })
      .catch(() => {
        if (!cancelled) setCredentials(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeVm?.name, phaseNumber]);

  // Push sidebar tab indicator based on overall phase.
  useEffect(() => {
    if (!status) {
      setMacosVmTabIndicator(null);
      return;
    }
    if (failed) {
      setMacosVmTabIndicator("failed");
      return;
    }
    if (!supported || !providerReady) {
      setMacosVmTabIndicator("blocker");
      return;
    }
    setMacosVmTabIndicator(phaseTen ? null : "blocker");
  }, [status, failed, supported, providerReady, phaseTen, setMacosVmTabIndicator]);

  useEffect(
    () => () => {
      setMacosVmTabIndicator(null);
    },
    [setMacosVmTabIndicator],
  );

  // VNC display lifecycle — only when running and during/after first-boot setup.
  const wantsDisplay = running && phaseNumber >= 5 && phaseNumber < 10;
  useEffect(() => {
    const container = displayContainerRef.current;
    const previousRfb = rfbRef.current;
    if (previousRfb) {
      previousRfb.disconnect();
      rfbRef.current = null;
    }
    if (container) container.innerHTML = "";
    if (!wantsDisplay || !activeVm?.laneId || !container) {
      setDisplayConnected(false);
      setDisplayMessage(null);
      return undefined;
    }

    let cancelled = false;
    let connected = false;
    let connectionTimedOut = false;
    let rfb: RFB | null = null;
    let connectTimer: number | null = null;
    const clearConnectTimer = () => {
      if (connectTimer) window.clearTimeout(connectTimer);
      connectTimer = null;
    };

    setDisplayConnected(false);
    setDisplayMessage("Connecting to the VM display…");
    connectTimer = window.setTimeout(() => {
      if (cancelled || connected) return;
      connectionTimedOut = true;
      setDisplayMessage("Timed out waiting for the embedded VM display.");
      rfb?.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
    }, DISPLAY_CONNECT_TIMEOUT_MS);

    window.ade.macosVm
      .getDisplaySession({ laneId: activeVm.laneId })
      .then((session) => {
        if (cancelled || connectionTimedOut) return;
        container.innerHTML = "";
        rfb = new RFB(container, session.websocketUrl, {
          shared: true,
          credentials: { password: session.password },
        });
        rfbRef.current = rfb;
        rfb.background = "#05070A";
        rfb.clipViewport = false;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.focusOnClick = true;
        rfb.addEventListener("connect", () => {
          if (cancelled) return;
          connected = true;
          clearConnectTimer();
          setDisplayConnected(true);
          setDisplayMessage(null);
        });
        rfb.addEventListener("credentialsrequired", () => {
          rfb?.sendCredentials({ password: session.password });
        });
        rfb.addEventListener("securityfailure", () => {
          if (cancelled) return;
          clearConnectTimer();
          setDisplayMessage("The VM display rejected the VNC credentials.");
        });
        rfb.addEventListener("disconnect", (event) => {
          if (cancelled || connectionTimedOut) return;
          clearConnectTimer();
          const clean = Boolean((event as CustomEvent<{ clean?: boolean }>).detail?.clean);
          setDisplayConnected(false);
          setDisplayMessage(
            clean ? null : "The embedded VM display disconnected. Restart the VM to recover.",
          );
        });
      })
      .catch((error) => {
        if (cancelled || connectionTimedOut) return;
        clearConnectTimer();
        setDisplayMessage(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
      clearConnectTimer();
      if (rfb) rfb.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
      if (container) container.innerHTML = "";
    };
  }, [activeVm?.laneId, wantsDisplay]);

  // First press opens the storage preflight modal; second press (after the
  // user confirms in the modal) actually starts provisioning.
  const startSetup = useCallback(async () => {
    if (!supported || !providerReady) {
      setMessage({
        tone: "error",
        text: !supported
          ? "Mac VMs require ADE on Apple silicon macOS."
          : "Lume is not available. Install Lume before setting up the Mac VM.",
      });
      return;
    }
    if (!lanes[0]) {
      setMessage({
        tone: "error",
        text: "Create a lane first in the Lanes tab, then set up the Mac VM from here.",
      });
      return;
    }
    setMessage(null);
    try {
      const info = await window.ade.macosVm.getStorageInfo();
      setSetupPreflight(info);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [lanes, providerReady, supported]);

  const confirmStartSetup = useCallback(async () => {
    // Singleton-VM model: provisioning is independent of which lane attaches.
    // `start({ createIfMissing: true })` runs provision (create VM disk via
    // `lume create --ipsw`) AND then boots the VM — the boot is what actually
    // installs macOS from the IPSW restore image. Calling `provision()`
    // alone leaves the VM in `stopped` and the user stuck at phase 3.
    const primerLane = lanes[0];
    if (!primerLane) return;
    setSetupPreflight(null);
    setBusy("setup");
    setMessage(null);
    try {
      // openDisplay:false → Lume runs `--no-display` AND ADE skips its own
      // openExternalVncClient call. Together that means zero external
      // Virtualization windows; the VM is rendered in-page via the embedded
      // RFB direct client.
      await window.ade.macosVm.start({
        laneId: primerLane.id,
        createIfMissing: true,
        openDisplay: false,
      });
      await refresh(false);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [lanes, refresh]);

  // Manual recovery for an existing-but-stopped VM (e.g. a previous run
  // called provision() without start, or the user stopped the VM mid-setup).
  const continueInstall = useCallback(async () => {
    if (!activeVm?.laneId) return;
    setBusy("setup");
    setMessage(null);
    try {
      await window.ade.macosVm.start({
        laneId: activeVm.laneId,
        createIfMissing: false,
        openDisplay: false,
      });
      await refresh(false);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [activeVm?.laneId, refresh]);

  const restartVm = useCallback(async () => {
    if (!activeVm?.name) return;
    const confirmed = window.confirm(`Restart ${activeVm.name}? Open chats will pause until the VM is back.`);
    if (!confirmed) return;
    setBusy("restart");
    setMessage(null);
    try {
      await window.ade.macosVm.restart({ vmName: activeVm.name });
      setMessage({ tone: "info", text: "Restart requested." });
      await refresh(false);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [activeVm?.name, refresh]);

  const wipeVm = useCallback(async () => {
    if (!activeVm?.name) return;
    const confirmed = window.confirm(
      "Wipe & reinstall the Mac VM?\n\nThis destroys the VM disk. If a VM lane is attached, it will be auto-detached (converted to local) first.\n\nSetup will start fresh next time.",
    );
    if (!confirmed) return;
    setBusy("wipe");
    setMessage(null);
    setManualCleanupPaths(null);
    try {
      const result = await window.ade.macosVm.wipe({ vmName: activeVm.name, confirm: true });
      const survivors = result.unreachablePaths ?? [];
      if (survivors.length > 0) {
        setMessage({
          tone: "info",
          text:
            "VM wiped, but ADE couldn't remove some paths (macOS marked them root-owned when the worktree was mounted in the VM). Use the command below to finish.",
        });
        setManualCleanupPaths(survivors);
      } else {
        setMessage({ tone: "info", text: "VM wiped. Set it up again when ready." });
      }
      await refresh(false);
      await refreshLanes({ includeStatus: false });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [activeVm?.name, refresh, refreshLanes]);

  const forceStopVm = useCallback(async () => {
    if (!activeVm?.laneId || !activeVm.name) return;
    const confirmed = window.confirm(
      `Force stop ${activeVm.name}? Any in-flight chat / shell turn will fail.`,
    );
    if (!confirmed) return;
    setBusy("force-stop");
    setMessage(null);
    try {
      await window.ade.macosVm.stop({ laneId: activeVm.laneId, force: true });
      setMessage({ tone: "info", text: "Force stop requested." });
      await refresh(false);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [activeVm?.laneId, activeVm?.name, refresh]);

  const installRuntime = useCallback(async () => {
    if (!activeVm?.name) return;
    setBusy("install-runtime");
    setMessage(null);
    try {
      const result = await window.ade.macosVm.installRuntime({ vmName: activeVm.name });
      setRuntimeInstall(result);
      await refresh(false);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [activeVm?.name, refresh]);

  const detachLane = useCallback(
    async (laneId: string) => {
      setBusy("detach");
      setMessage(null);
      try {
        const result = await window.ade.macosVm.detachLane({ laneId });
        setMessage(
          result.noOp
            ? { tone: "info", text: "Lane is already a local worktree — nothing to detach." }
            : {
                tone: "info",
                text: `Lane detached. It is now a local worktree${result.mirrorRemoved ? " (mirror removed)" : ""}.`,
              },
        );
        await refreshLanes({ includeStatus: false });
        await refresh(false);
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(null);
      }
    },
    [refresh, refreshLanes],
  );

  const openLaneInWork = useCallback(
    (laneId: string) => {
      navigate(`/work?laneId=${encodeURIComponent(laneId)}`);
    },
    [navigate],
  );

  const saveCredentials = useCallback(
    async ({ username, password }: { username: string; password: string }) => {
      if (!activeVm?.name) throw new Error("No VM selected.");
      setBusy("save-credentials");
      try {
        await window.ade.macosVm.setCredentials({ vmName: activeVm.name, username, password });
        const summary = await window.ade.macosVm.getCredentials({ vmName: activeVm.name });
        setCredentials(summary);
        setMessage({ tone: "info", text: "Credentials saved." });
        await refresh(false);
      } finally {
        setBusy(null);
      }
    },
    [activeVm?.name, refresh],
  );

  // Phase descriptors fed to the stepper.
  const phases: PhaseDescriptor[] = useMemo(() => {
    return MACOS_VM_PHASES.map((phase) => {
      let phaseStatus: PhaseStatus = "pending";
      if (phase.number < phaseNumber) phaseStatus = "complete";
      else if (phase.number === phaseNumber) phaseStatus = failed ? "blocked" : "active";

      let detail: PhaseDescriptor["detail"] = undefined;

      if (phase.number === 1) {
        detail = attachedVmLane
          ? `Lane "${attachedVmLane.name}" reserved for the Mac VM.`
          : "A lane will be reserved when you start setup.";
      } else if (phase.number === 2 && phase.number === phaseNumber) {
        // Two valid states for "phase 2 active":
        //   - download is in flight   → DownloadDetail with bytes/ETA
        //   - IPSW was cached         → no download events ever fire, lume
        //                               create is already running. Make this
        //                               state visible instead of an empty row.
        detail = downloadProgress ? (
          <DownloadDetail progress={downloadProgress} />
        ) : (
          <div className="flex flex-col gap-2 text-[11px]" style={{ color: "#A1A1AA" }}>
            <div className="flex items-center gap-1.5 font-semibold" style={{ color: "#FAFAFA" }}>
              <SpinnerGap size={11} className="animate-spin" style={{ color: "#34d399" }} />
              macOS installer cached — download skipped
            </div>
            <span>
              ADE is creating the VM disk via Lume right now (~5–15 min). The
              stepper will jump to <span style={{ color: "#D4D4D8" }}>Boot</span>{" "}
              once Lume finishes. You can switch tabs.
            </span>
          </div>
        );
      } else if (
        (phase.number === 3 || phase.number === 4 || phase.number === 5)
        && phase.number === phaseNumber
      ) {
        // The backend's lifecycle is coarse: `lume create --ipsw` only creates
        // the VM disk; the macOS install + first boot happens once we call
        // `start`. If we land here with the VM in `stopped`, the install
        // pipeline is stalled — surface a clear "Continue install" CTA so
        // the user can recover without manual CLI.
        const stoppedNeedingStart = activeVm?.state === "stopped";
        let provisioningText: string;
        if (phase.number === 3) provisioningText = "ADE is creating the VM disk via Lume.";
        else if (phase.number === 4) provisioningText = "Installing macOS into the VM disk (~10–30 min).";
        else provisioningText = "Booting the VM. Setup Assistant appears once it's up.";
        detail = (
          <div className="flex flex-col gap-2 text-[11px]" style={{ color: "#A1A1AA" }}>
            <span>{provisioningText}</span>
            {stoppedNeedingStart ? (
              <button
                type="button"
                onClick={() => void continueInstall()}
                disabled={busy === "setup"}
                className="inline-flex h-7 items-center gap-1.5 self-start rounded-md px-3 font-mono text-[10px] font-bold uppercase tracking-[1px]"
                style={{ background: "#A78BFA", color: "#0F0D14" }}
              >
                {busy === "setup" ? <SpinnerGap size={11} className="animate-spin" /> : null}
                Continue install
              </button>
            ) : null}
          </div>
        );
      } else if (phase.number === 6 && phase.number === phaseNumber) {
        detail = (
          <span>
            Follow the floating card over the console below. The 6 steps walk you through Setup Assistant.
          </span>
        );
      } else if (phase.number === 7 && phase.number === phaseNumber) {
        detail = (
          <span>
            Open Terminal in the VM and enable Remote Login. The first-boot card includes the exact command.
          </span>
        );
      } else if (phase.number === 8 && phase.number === phaseNumber) {
        if (sshAvailable && (!credentials || !credentials.hasPassword)) {
          detail = (
            <button
              type="button"
              onClick={() => setCredentialsOpen(true)}
              className="ade-shell-control inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-mono text-[10px] font-bold uppercase tracking-[1px]"
              data-variant="ghost"
            >
              Save credentials
            </button>
          );
        } else if (credentials?.hasPassword) {
          detail = <span>Credentials saved for {credentials.username ?? "ade"}.</span>;
        } else {
          detail = <span>Waiting for Remote Login before ADE can save credentials.</span>;
        }
      } else if (phase.number === 9 && phase.number === phaseNumber) {
        const installing = busy === "install-runtime" || runtimeStatus?.state === "installing";
        detail = (
          <div className="flex flex-col gap-2">
            {runtimeStatus ? <RuntimeInstallDetail status={runtimeStatus} /> : null}
            <button
              type="button"
              onClick={() => void installRuntime()}
              disabled={installing}
              className="ade-shell-control inline-flex h-7 items-center gap-1.5 self-start rounded-md px-2.5 font-mono text-[10px] font-bold uppercase tracking-[1px]"
              data-variant="ghost"
            >
              {installing ? <SpinnerGap size={11} className="animate-spin" /> : <DownloadSimple size={11} />}
              {installing ? "Installing…" : "Install agent runtime"}
            </button>
          </div>
        );
      } else if (phase.number === 10 && phase.number <= phaseNumber) {
        detail = (
          <CurrentVmLaneRow
            lane={attachedVmLane}
            busy={busy === "detach"}
            onOpenInWork={openLaneInWork}
            onDetach={(laneId) => void detachLane(laneId)}
          />
        );
      }

      return {
        number: phase.number,
        label: phase.label,
        status: phaseStatus,
        detail,
      };
    });
  }, [
    activeVm?.state,
    attachedVmLane,
    busy,
    continueInstall,
    credentials,
    detachLane,
    downloadProgress,
    failed,
    installRuntime,
    openLaneInWork,
    phaseNumber,
    runtimeStatus,
    sshAvailable,
  ]);

  const heroSummary = useMemo(() => {
    if (!activeVm) {
      if (!supported) return "Mac VMs require Apple silicon macOS.";
      if (!providerReady) return "Lume not available.";
      return "No Mac VM yet.";
    }
    return [
      activeVm.name,
      activeVm.ipAddress ?? null,
      macosVmPhaseLabel(phaseNumber),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join(" · ");
  }, [activeVm, providerReady, phaseNumber, supported]);

  // EMPTY STATE — no VM at all.
  if (!hasVm) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ color: "#FAFAFA" }}>
        <div
          className="flex shrink-0 items-center justify-between gap-4 px-5 py-3"
          style={{ borderBottom: "1px solid #1E1B26", background: "#0C0A10" }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <DesktopTower size={18} weight="duotone" style={{ color: "#A78BFA" }} />
              <span className="text-[15px] font-semibold" style={{ color: "#FAFAFA" }}>
                Mac VM
              </span>
            </div>
            <div className="mt-1 truncate text-[12px]" style={{ color: "#71717A" }}>
              {heroSummary}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh(true)}
            className="ade-shell-control inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-mono text-[10px] font-bold uppercase tracking-[1px]"
            data-variant="ghost"
            disabled={busy === "refresh"}
          >
            {busy === "refresh" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowClockwise size={13} />}
            Refresh
          </button>
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-10">
          <div className="flex flex-col items-center gap-4 text-center">
            <MacMiniGlyph />
            {busy === "setup" ? (
              <>
                <div className="flex items-center gap-2 text-[12px] font-semibold" style={{ color: "#FAFAFA" }}>
                  <SpinnerGap size={14} className="animate-spin" style={{ color: "#A78BFA" }} />
                  Preparing Mac VM setup
                </div>
                <p
                  className="max-w-[44ch] text-[12px] leading-5"
                  style={{ color: "#A1A1AA" }}
                >
                  Mirroring your worktree into the VM share. For large repos this
                  can take ~60 seconds before phase 2 (download) starts.
                </p>
              </>
            ) : (
              <>
                <p
                  className="max-w-[40ch] text-[13px] leading-6"
                  style={{ color: "#A1A1AA" }}
                >
                  No Mac VM yet. Set it up once; lanes then run inside it.
                </p>
                <button
                  type="button"
                  onClick={() => void startSetup()}
                  disabled={!supported || !providerReady}
                  className="inline-flex h-9 items-center gap-2 rounded-md px-4 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all duration-100 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none"
                  style={{ background: "#A78BFA", color: "#0F0D14" }}
                >
                  <Play size={13} weight="fill" />
                  Set up your Mac VM
                </button>
              </>
            )}
            {!supported ? (
              <div className="flex items-center gap-2 text-[11px]" style={{ color: "#FBBF24" }}>
                <WarningCircle size={13} weight="fill" />
                Mac VMs require ADE on Apple silicon macOS.
              </div>
            ) : !providerReady ? (
              <LumeMissingNotice tool={lumeToolStatus} />
            ) : null}
            {message ? (
              <MessageBanner message={message} />
            ) : null}
            {manualCleanupPaths && manualCleanupPaths.length > 0 ? (
              <ManualCleanupBanner
                paths={manualCleanupPaths}
                onDismiss={() => setManualCleanupPaths(null)}
              />
            ) : null}
          </div>
        </div>
        {setupPreflight ? (
          <SetupPreflightDialog
            info={setupPreflight}
            onCancel={() => setSetupPreflight(null)}
            onConfirm={() => void confirmStartSetup()}
          />
        ) : null}
      </div>
    );
  }

  const phaseSixActive = phaseNumber === 6 && running;
  const showConsole = wantsDisplay;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ color: "#FAFAFA" }}>
      {/* HERO STRIP */}
      <div
        className="flex shrink-0 items-center justify-between gap-4 px-5 py-3"
        style={{ borderBottom: "1px solid #1E1B26", background: "#0C0A10" }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <DesktopTower size={18} weight="duotone" style={{ color: "#A78BFA" }} />
            <span className="text-[15px] font-semibold" style={{ color: "#FAFAFA" }}>
              Mac VM
            </span>
            <StatusPill state={activeVm?.state ?? null} transient={transient} />
          </div>
          <div className="mt-1 truncate text-[12px]" style={{ color: "#71717A" }}>
            {heroSummary}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh(true)}
            className="ade-shell-control inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-mono text-[10px] font-bold uppercase tracking-[1px]"
            data-variant="ghost"
            disabled={busy === "refresh"}
          >
            {busy === "refresh" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowClockwise size={13} />}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void restartVm()}
            disabled={!activeVm?.name || busy === "restart"}
            className="ade-shell-control inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-mono text-[10px] font-bold uppercase tracking-[1px]"
            data-variant="ghost"
          >
            {busy === "restart" ? <SpinnerGap size={13} className="animate-spin" /> : null}
            Restart
          </button>
          <VmLifecycleMenu
            canRestart={Boolean(activeVm?.name)}
            canWipe={Boolean(activeVm?.name)}
            canForceStop={running}
            onRestart={() => void restartVm()}
            onWipe={() => void wipeVm()}
            onForceStop={() => void forceStopVm()}
          />
        </div>
      </div>

      {/* BODY */}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", phaseSixActive ? "relative" : "")}>
        {phaseSixActive ? (
          <ConsoleArea
            displayContainerRef={displayContainerRef}
            displayConnected={displayConnected}
            displayMessage={displayMessage}
            isFloating
          >
            <FirstBootCard
              steps={FIRST_BOOT_STEPS}
              currentStepIndex={firstBootStepIndex}
              onAdvance={() =>
                setFirstBootStepIndex((index) => Math.min(index + 1, FIRST_BOOT_STEPS.length - 1))
              }
              onSelectStep={setFirstBootStepIndex}
            />
          </ConsoleArea>
        ) : (
          <div className="grid min-h-0 flex-1 gap-4 overflow-auto px-5 py-4" style={gridStyle(showConsole, consoleExpanded)}>
            {!consoleExpanded ? (
              <section
                className="flex min-h-0 flex-col gap-3 rounded-lg p-4 overflow-auto"
                style={{ background: "#13101A", border: "1px solid #1E1B26" }}
              >
                <div
                  className="font-mono text-[10px] font-bold uppercase tracking-[1px]"
                  style={{ color: "#71717A" }}
                >
                  Setup
                </div>
                <PhaseStepper
                  phases={phases}
                  currentPhaseIndex={Math.max(0, phaseNumber - 1)}
                  compactMode={compactMode}
                  onToggleCompact={() => setCompactMode((value) => !value)}
                />
                {message ? <MessageBanner message={message} /> : null}
                {manualCleanupPaths && manualCleanupPaths.length > 0 ? (
                  <ManualCleanupBanner
                    paths={manualCleanupPaths}
                    onDismiss={() => setManualCleanupPaths(null)}
                  />
                ) : null}
                {compactMode ? (
                  <CurrentVmLaneRow
                    lane={attachedVmLane}
                    busy={busy === "detach"}
                    onOpenInWork={openLaneInWork}
                    onDetach={(laneId) => void detachLane(laneId)}
                  />
                ) : null}
              </section>
            ) : null}

            {showConsole ? (
              <ConsoleArea
                displayContainerRef={displayContainerRef}
                displayConnected={displayConnected}
                displayMessage={displayMessage}
                isFloating={false}
              >
                <ConsoleHeader
                  vmLabel={activeVm ? `${activeVm.name} · ${stateLabel(activeVm.state)}` : "No VM"}
                  expanded={consoleExpanded}
                  onToggleExpand={() => setConsoleExpanded((value) => !value)}
                />
              </ConsoleArea>
            ) : compactMode && activeVm ? (
              <CompactConsoleThumbnail
                vm={activeVm}
                onOpenFullConsole={() => {
                  setCompactMode(false);
                  setConsoleExpanded(true);
                }}
              />
            ) : null}
          </div>
        )}
      </div>

      <CredentialsPromptDialog
        open={credentialsOpen}
        vmName={activeVm?.name ?? null}
        defaultUsername={credentials?.username ?? "ade"}
        onOpenChange={setCredentialsOpen}
        onSave={saveCredentials}
        // Test-connection stub: we re-run the credentials probe by saving and
        // re-reading the summary. A real SSH probe will replace this once the
        // backend exposes a dedicated IPC.
      />
      {setupPreflight ? (
        <SetupPreflightDialog
          info={setupPreflight}
          onCancel={() => setSetupPreflight(null)}
          onConfirm={() => void confirmStartSetup()}
        />
      ) : null}
    </div>
  );
}

function SetupPreflightDialog({
  info,
  onCancel,
  onConfirm,
}: {
  info: MacosVmStorageInfo;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Volumes share a device id when they're on the same physical disk; collapse
  // to one row so we don't double-show free space.
  const sameVolume = info.ipswCache.volumeId === info.vmDisk.volumeId;
  // Credit any already-cached IPSW bytes against the "download now" estimate
  // and against the recommended free-space threshold — a resumable .part on
  // disk doesn't cost more space than it already takes.
  const remainingDownloadBytes = Math.max(0, info.estimatedIpswBytes - info.existingIpswBytes);
  const effectiveRecommendedFree = Math.max(0, info.recommendedFreeBytes - info.existingIpswBytes);
  const tightVolume = sameVolume
    ? info.ipswCache.availableBytes < effectiveRecommendedFree
    : info.ipswCache.availableBytes < remainingDownloadBytes
      || info.vmDisk.availableBytes < effectiveRecommendedFree;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: "rgba(8, 6, 12, 0.72)" }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[460px] rounded-lg p-5"
        style={{ background: "#13101A", border: "1px solid #1E1B26", color: "#FAFAFA" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 text-[14px] font-semibold">Set up your Mac VM?</div>
        <div className="mb-4 text-[12px] leading-5" style={{ color: "#A1A1AA" }}>
          ADE downloads the macOS restore image from Apple, creates a Lume VM,
          and installs macOS. This takes 30–60 minutes total and uses
          significant disk space.
        </div>
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
          <dt style={{ color: "#71717A" }}>
            {info.existingIpswBytes > 0 ? "Restore image (remaining)" : "Restore image (now)"}
          </dt>
          <dd className="text-right tabular-nums" style={{ color: "#D4D4D8" }}>
            ~{formatBytes(remainingDownloadBytes)}
          </dd>
          {info.existingIpswBytes > 0 ? (
            <>
              <dt style={{ color: "#71717A" }}>Already on disk</dt>
              <dd className="text-right tabular-nums" style={{ color: "var(--color-success, #34d399)" }}>
                {formatBytes(info.existingIpswBytes)} cached
              </dd>
            </>
          ) : null}
          <dt style={{ color: "#71717A" }}>Peak after install</dt>
          <dd className="text-right tabular-nums" style={{ color: "#D4D4D8" }}>
            ~{formatBytes(info.estimatedFullSetupBytes)}
          </dd>
          {sameVolume ? (
            <>
              <dt style={{ color: "#71717A" }}>Free on this volume</dt>
              <dd
                className="text-right tabular-nums font-semibold"
                style={{ color: tightVolume ? "#FBBF24" : "#34d399" }}
              >
                {formatBytes(info.ipswCache.availableBytes)}
              </dd>
            </>
          ) : (
            <>
              <dt style={{ color: "#71717A" }}>Free for image ({info.ipswCache.path})</dt>
              <dd
                className="text-right tabular-nums font-semibold"
                style={{ color: info.ipswCache.availableBytes < remainingDownloadBytes ? "#FBBF24" : "#34d399" }}
              >
                {formatBytes(info.ipswCache.availableBytes)}
              </dd>
              <dt style={{ color: "#71717A" }}>Free for VM disk ({info.vmDisk.path})</dt>
              <dd
                className="text-right tabular-nums font-semibold"
                style={{ color: info.vmDisk.availableBytes < effectiveRecommendedFree ? "#FBBF24" : "#34d399" }}
              >
                {formatBytes(info.vmDisk.availableBytes)}
              </dd>
            </>
          )}
        </dl>
        {tightVolume ? (
          <div
            className="mb-4 rounded-md px-3 py-2 text-[11px] leading-5"
            style={{
              background: "color-mix(in srgb, #FBBF24 9%, transparent)",
              border: "1px solid color-mix(in srgb, #FBBF24 28%, transparent)",
              color: "#FAFAFA",
            }}
          >
            Free space is below the recommended {formatBytes(effectiveRecommendedFree)}.
            Install may fail partway through.
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="ade-shell-control inline-flex h-8 items-center rounded-md px-3 text-[12px]"
            data-variant="ghost"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-8 items-center rounded-md px-3 font-mono text-[10px] font-bold uppercase tracking-[1px]"
            style={{ background: "#A78BFA", color: "#0F0D14" }}
          >
            {tightVolume ? "Continue anyway" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LumeMissingNotice({ tool }: { tool: MacosVmToolStatus | null }) {
  const hint = tool?.installHint?.trim() || "Install Lume from Cua to provision macOS VMs.";
  const docsUrl = tool?.docsUrl?.trim() || "https://cua.ai/docs/lume/guide/getting-started/installation";
  return (
    <div
      className="flex max-w-[44ch] flex-col gap-1.5 rounded-md px-3 py-2 text-left text-[11px] leading-5"
      style={{
        background: "color-mix(in srgb, #FBBF24 7%, transparent)",
        border: "1px solid color-mix(in srgb, #FBBF24 28%, transparent)",
        color: "#FAFAFA",
      }}
    >
      <div className="flex items-center gap-1.5 font-semibold" style={{ color: "#FBBF24" }}>
        <WarningCircle size={13} weight="fill" /> Lume isn&apos;t installed
      </div>
      <div style={{ color: "#D4D4D8" }}>{hint}</div>
      <a
        href={docsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start font-mono text-[10px] font-bold uppercase tracking-[1px] underline-offset-2 hover:underline"
        style={{ color: "#A78BFA" }}
      >
        Open Lume install guide ↗
      </a>
    </div>
  );
}

/**
 * POSIX-safe single-quote escape: wraps `value` in single quotes and
 * neutralizes any embedded single quote with the canonical close-escape-reopen
 * sequence. Single-quoted strings disable every shell expansion (including
 * `$(...)`, `` `...` ``, and parameter expansion), so a path captured here
 * cannot execute unintended commands when the user pastes the copied line.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ManualCleanupBanner({
  paths,
  onDismiss,
}: {
  paths: string[];
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const command = `sudo rm -rf ${paths.map((p) => shellSingleQuote(p)).join(" ")}`;
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);
  return (
    <div
      className="rounded-md px-3 py-2.5 text-[12px] leading-5"
      style={{
        background: "color-mix(in srgb, #FBBF24 7%, transparent)",
        border: "1px solid color-mix(in srgb, #FBBF24 28%, transparent)",
        color: "#FAFAFA",
      }}
    >
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.6px]" style={{ color: "#FBBF24" }}>
        Finish cleanup in Terminal
      </div>
      <div className="mb-2 text-[11px]" style={{ color: "#D4D4D8" }}>
        macOS made these paths root-owned (auto-created `.Trashes/` on the
        VM-shared volume). ADE can&apos;t remove them without `sudo`. Copy and run:
      </div>
      <div
        className="mb-2 overflow-x-auto rounded px-2.5 py-1.5 font-mono text-[11px] leading-[1.4]"
        style={{ background: "#0E0B14", border: "1px solid #1E1B26", color: "#E4E4E7" }}
      >
        {command}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
          style={{
            background: copied ? "color-mix(in srgb, var(--color-success, #34d399) 22%, transparent)" : "#1E1B26",
            border: `1px solid ${copied ? "var(--color-success, #34d399)" : "#2A2632"}`,
            color: "#FAFAFA",
          }}
        >
          {copied ? "Copied" : "Copy command"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-2.5 py-1 text-[11px] transition-colors"
          style={{ color: "#A1A1AA" }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function MessageBanner({ message }: { message: NonNullable<Message> }) {
  return (
    <div
      className="rounded-md px-3 py-2 text-[12px] leading-5"
      style={
        message.tone === "error"
          ? {
            background: "color-mix(in srgb, var(--color-error, #ef4444) 9%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-error, #ef4444) 28%, transparent)",
            color: "color-mix(in srgb, var(--color-error, #ef4444) 60%, #FAFAFA)",
          }
          : {
            background: "#13101A",
            border: "1px solid #1E1B26",
            color: "#A1A1AA",
          }
      }
    >
      {message.text}
    </div>
  );
}

function gridStyle(showConsole: boolean, consoleExpanded: boolean): CSSProperties {
  if (consoleExpanded) return { gridTemplateColumns: "1fr" };
  if (showConsole) return { gridTemplateColumns: "minmax(360px, 0.9fr) minmax(460px, 1.25fr)" };
  return { gridTemplateColumns: "1fr" };
}

function ConsoleArea({
  displayContainerRef,
  displayConnected,
  displayMessage,
  isFloating,
  children,
}: {
  displayContainerRef: React.MutableRefObject<HTMLDivElement | null>;
  displayConnected: boolean;
  displayMessage: string | null;
  isFloating: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative flex min-h-0 flex-1 overflow-hidden",
        isFloating ? "" : "rounded-lg",
      )}
      style={{ background: "#05070A", border: isFloating ? "none" : "1px solid #1E1B26" }}
    >
      <div ref={displayContainerRef} className="absolute inset-0" />
      {!displayConnected ? (
        <div
          className="absolute inset-x-6 top-1/2 mx-auto flex max-w-[430px] -translate-y-1/2 flex-col items-center gap-2 rounded-lg px-4 py-3 text-center"
          style={{
            background: "rgba(12, 10, 16, 0.88)",
            border: "1px solid rgba(167, 139, 250, 0.35)",
            boxShadow: "0 18px 50px rgba(0,0,0,0.38)",
          }}
        >
          <SpinnerGap size={18} className="animate-spin" style={{ color: "#A78BFA" }} />
          <div className="text-[12px] font-semibold" style={{ color: "#FAFAFA" }}>
            {displayMessage ? "Embedded display" : "Connecting VM display…"}
          </div>
          {displayMessage ? (
            <div className="text-[11px] leading-5" style={{ color: "#A1A1AA" }}>
              {displayMessage}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function ConsoleHeader({
  vmLabel,
  expanded,
  onToggleExpand,
}: {
  vmLabel: string;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  return (
    <div
      className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-md px-2.5 py-1.5"
      style={{ background: "rgba(12, 10, 16, 0.78)", border: "1px solid #1E1B26" }}
    >
      <span className="font-mono text-[10px] font-bold uppercase tracking-[1px]" style={{ color: "#A1A1AA" }}>
        {vmLabel}
      </span>
      <button
        type="button"
        onClick={onToggleExpand}
        className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded-md"
        data-variant="ghost"
        aria-label={expanded ? "Collapse console" : "Expand console"}
      >
        {expanded ? <ArrowsInSimple size={11} /> : <ArrowsOutSimple size={11} />}
      </button>
    </div>
  );
}

function CompactConsoleThumbnail({
  vm,
  onOpenFullConsole,
}: {
  vm: MacosVmRecord;
  onOpenFullConsole: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-md p-3"
      style={{ background: "#13101A", border: "1px solid #1E1B26" }}
    >
      <div
        className="flex h-12 w-20 items-center justify-center rounded-md"
        style={{ background: "#05070A", border: "1px solid #1E1B26" }}
      >
        <DesktopTower size={20} weight="duotone" style={{ color: "#A78BFA" }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold" style={{ color: "#FAFAFA" }}>
          {vm.name}
        </div>
        <div className="mt-0.5 truncate text-[11px]" style={{ color: "#71717A" }}>
          {vm.ipAddress ?? "Running"}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenFullConsole}
        className="ade-shell-control inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-mono text-[10px] font-bold uppercase tracking-[1px]"
        data-variant="ghost"
      >
        <GitBranch size={11} />
        Open full console
      </button>
    </div>
  );
}
