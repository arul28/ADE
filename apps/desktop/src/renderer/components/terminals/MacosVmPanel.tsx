import { type MouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Cpu,
  CursorClick,
  Desktop,
  ImageSquare,
  Keyboard,
  Play,
  SpinnerGap,
  Stop,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  MacosVmEventPayload,
  MacosVmLifecycleState,
  MacosVmContextItem,
  MacosVmProvisionMode,
  MacosVmRecord,
  MacosVmStatus,
} from "../../../shared/types";
import { cn } from "../ui/cn";

type MacosVmPanelProps = {
  laneId: string;
  laneRoot: string | null;
  onAddContext?: (item: MacosVmContextItem) => void;
};

type Message = { tone: "info" | "error"; text: string };
type BusyAction = "refresh" | "provision" | "start" | "stop" | "delete" | "focus" | "screenshot" | "select" | "click" | "type" | null;
type SelectedPoint = { x: number; y: number };
type PreviewSize = { width: number; height: number };

const DEFAULT_CPU_CORES = 4;
const DEFAULT_MEMORY = "8GB";
const DEFAULT_DISK_SIZE = "80GB";
const DEFAULT_DISPLAY = "1920x1200";

const STATE_TONE: Record<MacosVmLifecycleState, string> = {
  not_created: "border-white/[0.08] bg-white/[0.03] text-muted-fg/70",
  creating: "border-amber-400/25 bg-amber-500/10 text-amber-100/85",
  installing: "border-amber-400/25 bg-amber-500/10 text-amber-100/85",
  stopped: "border-white/[0.08] bg-white/[0.03] text-muted-fg/70",
  starting: "border-amber-400/25 bg-amber-500/10 text-amber-100/85",
  running: "border-emerald-400/25 bg-emerald-500/10 text-emerald-100/85",
  stopping: "border-amber-400/25 bg-amber-500/10 text-amber-100/85",
  paused: "border-sky-400/25 bg-sky-500/10 text-sky-100/85",
  failed: "border-rose-400/30 bg-rose-500/10 text-rose-200/85",
  unknown: "border-white/[0.08] bg-white/[0.03] text-muted-fg/70",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateLabel(state: MacosVmLifecycleState | null | undefined): string {
  if (!state) return "Not created";
  return state.replace(/_/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandForVm(vm: MacosVmRecord | null, laneRoot: string | null): string {
  if (!vm) return laneRoot ? `lume run <vm-name> --shared-dir ${shellQuote(laneRoot)}` : "lume run <vm-name> --shared-dir <lane-root>";
  return `lume run ${shellQuote(vm.name)} --shared-dir ${shellQuote(vm.sharedDirectory)}`;
}

export function MacosVmPanel({
  laneId,
  laneRoot,
  onAddContext,
}: MacosVmPanelProps) {
  const [status, setStatus] = useState<MacosVmStatus | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [cpuCores, setCpuCores] = useState(DEFAULT_CPU_CORES);
  const [memory, setMemory] = useState(DEFAULT_MEMORY);
  const [diskSize, setDiskSize] = useState(DEFAULT_DISK_SIZE);
  const [display, setDisplay] = useState(DEFAULT_DISPLAY);
  const [mode, setMode] = useState<MacosVmProvisionMode>("pull-image");
  const [sourceImage, setSourceImage] = useState("macos-tahoe-vanilla:latest");
  const [openDisplay, setOpenDisplay] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<PreviewSize | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(null);
  const [typeValue, setTypeValue] = useState("");

  const vm = status?.laneVm ?? null;
  const running = vm?.state === "running";
  const providerReady = status?.activeProvider.available === true;
  const platformSupported = status?.supported !== false;
  const canOperate = Boolean(providerReady && platformSupported && laneId && !busyAction);
  const command = useMemo(() => commandForVm(vm, laneRoot), [laneRoot, vm]);

  const refresh = useCallback(async (forceMessage = false) => {
    setBusyAction((current) => current ?? "refresh");
    try {
      const next = await window.ade.macosVm.getStatus({ laneId });
      setStatus(next);
      if (forceMessage) setMessage({ tone: "info", text: "macOS VM status refreshed." });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusyAction((current) => current === "refresh" ? null : current);
    }
  }, [laneId]);

  useEffect(() => {
    void refresh(false);
    const unsubscribe = window.ade.macosVm.onEvent((event: MacosVmEventPayload) => {
      if (event.type === "status") {
        setStatus(event.status);
      } else if (event.type === "vm-updated" && event.vm.laneId === laneId) {
        setStatus((current) => current ? { ...current, laneVm: event.vm, vms: current.vms.map((entry) => entry.laneId === event.vm.laneId ? event.vm : entry) } : current);
      } else if (event.type === "operation" && event.laneId === laneId) {
        setMessage({
          tone: event.state === "failed" ? "error" : "info",
          text: event.message,
        });
      }
    });
    return unsubscribe;
  }, [laneId, refresh]);

  const runAction = useCallback(async (action: Exclude<BusyAction, null>, fn: () => Promise<unknown>, done: string) => {
    if (!fn) return;
    setBusyAction(action);
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "info", text: done });
      await refresh(false);
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }, [refresh]);

  const provision = useCallback(() => runAction(
    "provision",
    () => window.ade.macosVm.provision({
      laneId,
      cpuCores,
      memory,
      diskSize,
      display,
      mode,
      sourceImage: mode === "pull-image" ? sourceImage : undefined,
    }),
    "Provisioning finished.",
  ), [cpuCores, diskSize, display, laneId, memory, mode, runAction, sourceImage]);

  const start = useCallback(() => runAction(
    "start",
    () => window.ade.macosVm.start({
      laneId,
      openDisplay,
      createIfMissing: true,
      cpuCores,
      memory,
      diskSize,
      display,
      mode,
      sourceImage: mode === "pull-image" ? sourceImage : undefined,
    }),
    "VM started with this lane mounted.",
  ), [cpuCores, diskSize, display, laneId, memory, mode, openDisplay, runAction, sourceImage]);

  const stop = useCallback(() => runAction(
    "stop",
    () => window.ade.macosVm.stop({ laneId }),
    "VM stopped.",
  ), [laneId, runAction]);

  const deleteVm = useCallback(() => {
    if (!window.confirm("Delete this lane's macOS VM? The lane worktree is not deleted.")) return;
    void runAction(
      "delete",
      () => window.ade.macosVm.delete({ laneId, force: true }),
      "VM deleted.",
    );
  }, [laneId, runAction]);

  const focusWindow = useCallback(() => runAction(
    "focus",
    () => window.ade.macosVm.focusWindow({ laneId }),
    "VM window focused.",
  ), [laneId, runAction]);

  const captureScreenshot = useCallback(async () => {
    setBusyAction("screenshot");
    setMessage(null);
    try {
      const result = await window.ade.macosVm.captureScreenshot({ laneId });
      setScreenshotPath(result.path);
      setScreenshotDataUrl(result.dataUrl ?? null);
      setPreviewSize(null);
      setSelectedPoint(null);
      setMessage({ tone: "info", text: result.dataUrl ? "Captured VM screenshot." : `Screenshot saved to ${result.path}.` });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }, [laneId]);

  const selectPreviewPoint = useCallback(async (event: MouseEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const sourceWidth = event.currentTarget.naturalWidth || previewSize?.width || rect.width;
    const sourceHeight = event.currentTarget.naturalHeight || previewSize?.height || rect.height;
    if (!rect.width || !rect.height || !sourceWidth || !sourceHeight) return;
    const x = Math.max(0, Math.round(((event.clientX - rect.left) / rect.width) * sourceWidth));
    const y = Math.max(0, Math.round(((event.clientY - rect.top) / rect.height) * sourceHeight));
    setBusyAction("select");
    setMessage(null);
    try {
      const result = await window.ade.macosVm.selectPoint({
        laneId,
        x,
        y,
        coordinateSpace: "window",
        includeScreenshot: true,
      });
      setSelectedPoint({ x, y });
      if (result.item.screenshotDataUrl) setScreenshotDataUrl(result.item.screenshotDataUrl);
      if (result.screenshot?.path) setScreenshotPath(result.screenshot.path);
      onAddContext?.(result.item);
      setMessage({ tone: "info", text: onAddContext ? "Attached VM point context to chat." : "Selected VM point." });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }, [laneId, onAddContext, previewSize]);

  const clickSelectedPoint = useCallback(() => runAction(
    "click",
    async () => {
      if (!selectedPoint) throw new Error("Select a VM screenshot point first.");
      await window.ade.macosVm.click({
        laneId,
        x: selectedPoint.x,
        y: selectedPoint.y,
        coordinateSpace: "window",
      });
    },
    "Clicked selected VM point.",
  ), [laneId, runAction, selectedPoint]);

  const typeIntoVm = useCallback(() => runAction(
    "type",
    async () => {
      if (!typeValue.length) throw new Error("Enter text to type into the VM.");
      await window.ade.macosVm.typeText({ laneId, text: typeValue });
    },
    "Typed into VM window.",
  ), [laneId, runAction, typeValue]);

  const openDocs = useCallback((url: string | undefined) => {
    if (!url) return;
    void window.ade.app.openExternal(url);
  }, []);

  const Spinner = busyAction ? <SpinnerGap size={13} className="animate-spin" /> : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-[12px] text-fg/85">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <Desktop size={16} weight="fill" className="text-fg/75" />
            <span>macOS VM</span>
          </div>
          <div className="mt-1 text-[11px] leading-4 text-muted-fg/65">
            A VM belongs to the active lane and mounts that lane through VirtioFS.
          </div>
        </div>
        <button
          type="button"
          className="ade-shell-control inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          data-variant="ghost"
          title="Refresh macOS VM status"
          onClick={() => void refresh(true)}
          disabled={busyAction === "refresh"}
        >
          {busyAction === "refresh" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowClockwise size={13} />}
        </button>
      </div>

      {message ? (
        <div
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] leading-4",
            message.tone === "error"
              ? "border-rose-400/25 bg-rose-500/10 text-rose-100/85"
              : "border-white/[0.08] bg-white/[0.03] text-muted-fg/75",
          )}
        >
          <WarningCircle size={14} weight="fill" className={cn("mt-0.5 shrink-0", message.tone === "error" ? "text-rose-200/80" : "text-muted-fg/60")} />
          <span>{message.text}</span>
        </div>
      ) : null}

      <div className="rounded-md border border-white/[0.08] bg-white/[0.025] px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[12px] font-medium text-fg">{vm?.name ?? "No VM provisioned"}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-fg/55">{laneRoot ?? "Lane root unavailable"}</div>
          </div>
          <span className={cn("shrink-0 rounded-full border px-2 py-1 text-[10px] font-medium", STATE_TONE[vm?.state ?? "not_created"])}>
            {stateLabel(vm?.state)}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-fg/65">
          <div>
            <div className="text-muted-fg/40">Provider</div>
            <div className="truncate text-fg/75">{status?.activeProvider.available ? "Lume" : "Unavailable"}</div>
          </div>
          <div>
            <div className="text-muted-fg/40">Guest path</div>
            <div className="truncate text-fg/75">{vm?.guestSharedPath ?? "/Volumes/My Shared Files"}</div>
          </div>
          <div>
            <div className="text-muted-fg/40">IP</div>
            <div className="truncate text-fg/75">{vm?.ipAddress ?? "Not assigned"}</div>
          </div>
          <div>
            <div className="text-muted-fg/40">SSH</div>
            <div className="truncate text-fg/75">{vm?.sshCommand ?? "Configure in guest"}</div>
          </div>
        </div>
      </div>

      {!platformSupported || !providerReady ? (
        <div className="rounded-md border border-amber-400/18 bg-amber-500/[0.07] px-3 py-3 text-[11px] leading-4 text-amber-100/85">
          <div className="font-medium text-amber-50/90">
            {!platformSupported ? "Apple silicon Mac required" : "Install Lume to run VMs"}
          </div>
          <div className="mt-1">
            {status?.activeProvider.detail ?? "ADE will use Lume as the first VM provider while the native Apple Virtualization helper is built out."}
          </div>
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-200/20 px-2 py-1 text-[11px] text-amber-50/90"
            onClick={() => openDocs(status?.activeProvider.docsUrl)}
          >
            <ArrowSquareOut size={12} />
            Setup docs
          </button>
        </div>
      ) : null}

      <div className="rounded-md border border-white/[0.08] bg-white/[0.025] px-3 py-3">
        <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-fg/85">
          <Cpu size={14} />
          <span>Provisioning</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-fg/50">CPU</span>
            <input
              className="ade-input h-8 rounded-md px-2 text-[12px]"
              type="number"
              min={1}
              max={32}
              value={cpuCores}
              onChange={(event) => setCpuCores(Math.max(1, Number(event.target.value) || DEFAULT_CPU_CORES))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-fg/50">Memory</span>
            <input className="ade-input h-8 rounded-md px-2 text-[12px]" value={memory} onChange={(event) => setMemory(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-fg/50">Disk</span>
            <input className="ade-input h-8 rounded-md px-2 text-[12px]" value={diskSize} onChange={(event) => setDiskSize(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-fg/50">Display</span>
            <input className="ade-input h-8 rounded-md px-2 text-[12px]" value={display} onChange={(event) => setDisplay(event.target.value)} />
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1">
          <span className="text-[10px] text-muted-fg/50">Source</span>
          <select
            className="ade-input h-8 rounded-md px-2 text-[12px]"
            value={mode}
            onChange={(event) => setMode(event.target.value === "create" ? "create" : "pull-image")}
          >
            <option value="pull-image">Pull prepared macOS image</option>
            <option value="create">Create from Apple restore image</option>
          </select>
        </label>
        {mode === "pull-image" ? (
          <input
            className="ade-input mt-2 h-8 w-full rounded-md px-2 text-[12px]"
            value={sourceImage}
            onChange={(event) => setSourceImage(event.target.value)}
            placeholder="macos-tahoe-vanilla:latest"
          />
        ) : null}
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-[11px] text-muted-fg/70">
        <span>Open local viewer window when starting</span>
        <input type="checkbox" checked={openDisplay} onChange={(event) => setOpenDisplay(event.target.checked)} />
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="ade-work-new-chat-btn inline-flex items-center gap-2 px-3 py-2 text-[12px] font-medium"
          onClick={start}
          disabled={!canOperate || busyAction === "start"}
        >
          {busyAction === "start" ? Spinner : <Play size={13} weight="fill" />}
          Start
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-2 rounded-md px-3 py-2 text-[12px]"
          data-variant="default"
          onClick={provision}
          disabled={!canOperate || busyAction === "provision"}
        >
          {busyAction === "provision" ? Spinner : <Desktop size={13} />}
          Provision
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-2 rounded-md px-3 py-2 text-[12px]"
          data-variant="ghost"
          onClick={stop}
          disabled={!canOperate || !running || busyAction === "stop"}
        >
          {busyAction === "stop" ? Spinner : <Stop size={13} />}
          Stop
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-2 rounded-md px-3 py-2 text-[12px]"
          data-variant="ghost"
          onClick={focusWindow}
          disabled={!canOperate || !running || busyAction === "focus"}
        >
          {busyAction === "focus" ? Spinner : <ArrowSquareOut size={13} />}
          Focus
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-2 rounded-md px-3 py-2 text-[12px]"
          data-variant="ghost"
          onClick={() => void captureScreenshot()}
          disabled={!canOperate || !running || busyAction === "screenshot"}
        >
          {busyAction === "screenshot" ? Spinner : <ImageSquare size={13} />}
          Screenshot
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-2 rounded-md px-3 py-2 text-[12px] text-rose-100/80"
          data-variant="ghost"
          onClick={deleteVm}
          disabled={!canOperate || !vm || busyAction === "delete"}
        >
          {busyAction === "delete" ? Spinner : <Trash size={13} />}
          Delete
        </button>
      </div>

      <div className="rounded-md border border-white/[0.08] bg-white/[0.025] px-3 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12px] font-medium text-fg/85">
            <CursorClick size={14} />
            <span>VM input</span>
          </div>
          {selectedPoint ? (
            <span className="rounded-full border border-white/[0.08] bg-black/20 px-2 py-1 font-mono text-[10px] text-muted-fg/70">
              {selectedPoint.x}, {selectedPoint.y}
            </span>
          ) : null}
        </div>
        {screenshotDataUrl ? (
          <div className="relative overflow-hidden rounded-md border border-white/[0.08] bg-black/30">
            <img
              src={screenshotDataUrl}
              alt="macOS VM screenshot"
              className={cn(
                "block max-h-[220px] w-full object-contain",
                running ? "cursor-crosshair" : "cursor-default",
              )}
              onClick={running ? selectPreviewPoint : undefined}
              onLoad={(event) => {
                setPreviewSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
            />
            {selectedPoint && previewSize ? (
              <span
                className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-100 bg-cyan-400/80 shadow-[0_0_12px_rgba(34,211,238,0.55)]"
                style={{
                  left: `${(selectedPoint.x / previewSize.width) * 100}%`,
                  top: `${(selectedPoint.y / previewSize.height) * 100}%`,
                }}
              />
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-white/[0.08] bg-black/15 px-3 py-6 text-center text-[11px] text-muted-fg/55">
            No VM screenshot captured.
          </div>
        )}
        {screenshotPath ? (
          <div className="mt-2 truncate font-mono text-[10px] text-muted-fg/45">{screenshotPath}</div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="ade-shell-control inline-flex items-center gap-2 rounded-md px-3 py-2 text-[12px]"
            data-variant="ghost"
            onClick={clickSelectedPoint}
            disabled={!canOperate || !running || !selectedPoint || busyAction === "click"}
          >
            {busyAction === "click" ? Spinner : <CursorClick size={13} />}
            Click point
          </button>
          <div className="flex min-w-[180px] flex-1 items-center gap-2">
            <input
              className="ade-input h-8 min-w-0 flex-1 rounded-md px-2 text-[12px]"
              value={typeValue}
              onChange={(event) => setTypeValue(event.target.value)}
              placeholder="Text"
              disabled={!canOperate || !running}
            />
            <button
              type="button"
              className="ade-shell-control inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-[12px]"
              data-variant="ghost"
              onClick={typeIntoVm}
              disabled={!canOperate || !running || !typeValue.length || busyAction === "type"}
            >
              {busyAction === "type" ? Spinner : <Keyboard size={13} />}
              Type
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 rounded-md border border-white/[0.08] bg-black/15 px-3 py-2 font-mono text-[11px] leading-5 text-muted-fg/70">
        <div className="mb-1 text-[10px] font-sans text-muted-fg/45">Run command</div>
        <div className="break-all">{command}</div>
      </div>

      <div className="rounded-md border border-white/[0.08] bg-white/[0.025] px-3 py-3 text-[11px] leading-4 text-muted-fg/65">
        <div className="font-medium text-fg/75">Control model</div>
        <div className="mt-1">
          ADE targets headless VNC when available. For commands, use SSH or an in-guest agent against the mounted lane path.
        </div>
      </div>
    </div>
  );
}
