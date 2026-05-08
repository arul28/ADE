import { type MouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Camera,
  CheckCircle,
  Copy,
  CursorClick,
  FloppyDisk,
  FolderOpen,
  Keyboard,
  PencilSimple,
  Play,
  SpinnerGap,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import type {
  MacosVmBaseRecord,
  MacosVmContextItem,
  MacosVmRecord,
  MacosVmStatus,
} from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { CockpitDrawer } from "./CockpitDrawer";
import { seedSnapshotName } from "./snapshotNaming";

type CockpitMessage = { tone: "info" | "error"; text: string };

type Props = {
  status: MacosVmStatus;
  vm: MacosVmRecord;
  laneId: string;
  bases: MacosVmBaseRecord[];
  onAddContext?: (item: MacosVmContextItem) => void;
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatUptime(startedAt: string | null | undefined): string {
  if (!startedAt) return "—";
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

function copyText(text: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(text);
  }
}

function StatePill({ state, label }: { state: "running" | "stopped" | "starting" | "stopping" | "transient" | "failed"; label: string }) {
  const tone =
    state === "running"
      ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-100/90"
      : state === "failed"
        ? "border-rose-400/30 bg-rose-500/10 text-rose-100/90"
        : state === "stopped"
          ? "border-white/[0.08] bg-white/[0.04] text-muted-fg/85"
          : "border-amber-400/25 bg-amber-500/10 text-amber-100/90";
  const dotTone =
    state === "running"
      ? "bg-emerald-400"
      : state === "failed"
        ? "bg-rose-400"
        : state === "stopped"
          ? "bg-white/45"
          : "bg-amber-300";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium", tone)}>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          dotTone,
          state === "running" ? "shadow-[0_0_8px_currentColor]" : null,
          state === "starting" || state === "stopping" || state === "transient" ? "animate-pulse" : null,
        )}
        aria-hidden
      />
      {label}
    </span>
  );
}

export function MacosVmCockpit({ status, vm, laneId, bases, onAddContext }: Props) {
  const running = vm.state === "running";
  const stopped = vm.state === "stopped";
  const [message, setMessage] = useState<CockpitMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [typeValue, setTypeValue] = useState("");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<{ x: number; y: number } | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDescription, setSaveDescription] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const stateForPill: "running" | "stopped" | "starting" | "stopping" | "transient" | "failed" = useMemo(() => {
    if (vm.state === "running") return "running";
    if (vm.state === "stopped") return "stopped";
    if (vm.state === "failed") return "failed";
    if (vm.state === "starting") return "starting";
    if (vm.state === "stopping") return "stopping";
    return "transient";
  }, [vm.state]);

  const uptime = useMemo(() => {
    if (!running) return "—";
    void now;
    return formatUptime(vm.lastStartedAt);
  }, [running, vm.lastStartedAt, now]);

  const clonedFromName = typeof vm.metadata.fromBaseName === "string" ? vm.metadata.fromBaseName : null;
  const clonedFromBase = useMemo(
    () => (clonedFromName ? bases.find((b) => b.name === clonedFromName) ?? null : null),
    [bases, clonedFromName],
  );

  const exec = useCallback(
    async (key: string, fn: () => Promise<unknown>, doneText?: string) => {
      setBusy(key);
      setMessage(null);
      try {
        await fn();
        if (doneText) setMessage({ tone: "info", text: doneText });
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const focusVmWindow = useCallback(
    () => exec("focus", () => window.ade.macosVm.focusWindow({ laneId }), "VM window focused."),
    [exec, laneId],
  );
  const stop = useCallback(
    () => exec("stop", () => window.ade.macosVm.stop({ laneId }), "VM stopped."),
    [exec, laneId],
  );
  const start = useCallback(
    () =>
      exec(
        "start",
        () =>
          window.ade.macosVm.start({
            laneId,
            createIfMissing: false,
            openDisplay: true,
          }),
        "VM started.",
      ),
    [exec, laneId],
  );
  const restart = useCallback(async () => {
    setBusy("restart");
    setMessage(null);
    try {
      await window.ade.macosVm.stop({ laneId });
      await window.ade.macosVm.start({ laneId, createIfMissing: false, openDisplay: true });
      setMessage({ tone: "info", text: "VM restarted." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [laneId]);

  const captureScreenshot = useCallback(async () => {
    setBusy("screenshot");
    setMessage(null);
    try {
      const result = await window.ade.macosVm.captureScreenshot({ laneId });
      setScreenshotPath(result.path);
      setScreenshotDataUrl(result.dataUrl ?? null);
      setSelectedPoint(null);
      setPreviewSize(null);
      setMessage({ tone: "info", text: result.dataUrl ? "Captured VM screenshot." : `Screenshot saved to ${result.path}.` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [laneId]);

  const typeIntoVm = useCallback(async () => {
    if (!typeValue.length) return;
    setBusy("type");
    setMessage(null);
    try {
      await window.ade.macosVm.typeText({ laneId, text: typeValue });
      setMessage({ tone: "info", text: "Typed into VM window." });
      setTypeValue("");
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [laneId, typeValue]);

  const selectPreviewPoint = useCallback(
    async (event: MouseEvent<HTMLImageElement>) => {
      if (!running) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const sourceWidth = event.currentTarget.naturalWidth || previewSize?.width || rect.width;
      const sourceHeight = event.currentTarget.naturalHeight || previewSize?.height || rect.height;
      if (!rect.width || !rect.height || !sourceWidth || !sourceHeight) return;
      const x = Math.max(0, Math.round(((event.clientX - rect.left) / rect.width) * sourceWidth));
      const y = Math.max(0, Math.round(((event.clientY - rect.top) / rect.height) * sourceHeight));
      setBusy("select");
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
        setMessage({ tone: "info", text: onAddContext ? "Attached VM point to chat." : "Selected VM point." });
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(null);
      }
    },
    [laneId, onAddContext, previewSize, running],
  );

  const clickSelectedPoint = useCallback(async () => {
    if (!selectedPoint) return;
    setBusy("click");
    setMessage(null);
    try {
      await window.ade.macosVm.click({
        laneId,
        x: selectedPoint.x,
        y: selectedPoint.y,
        coordinateSpace: "window",
      });
      setMessage({ tone: "info", text: "Clicked selected VM point." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [laneId, selectedPoint]);

  const openSaveDialog = useCallback(() => {
    if (!stopped) return;
    setSaveName(seedSnapshotName(status, clonedFromName));
    setSaveDescription("");
    setShowSaveDialog(true);
  }, [clonedFromName, status, stopped]);

  const confirmSaveSnapshot = useCallback(async () => {
    const trimmed = saveName.trim();
    if (!trimmed) return;
    await exec(
      "save-snapshot",
      () =>
        window.ade.macosVm.saveLaneVmAsSnapshot({
          laneId,
          name: trimmed,
          description: saveDescription.trim() || null,
        }),
      `Saved snapshot "${trimmed}".`,
    );
    setShowSaveDialog(false);
  }, [exec, laneId, saveDescription, saveName]);

  const renameSnapshot = useCallback(
    async (from: string) => {
      const next = window.prompt("Rename snapshot", from);
      if (!next || next.trim() === from) return;
      await exec(
        `rename-${from}`,
        () => window.ade.macosVm.renameBase({ from, to: next.trim() }),
        `Renamed to ${next.trim()}.`,
      );
    },
    [exec],
  );

  const deleteSnapshot = useCallback(
    async (name: string) => {
      if (!window.confirm(`Delete snapshot "${name}"? This cannot be undone.`)) return;
      await exec(
        `delete-${name}`,
        () => window.ade.macosVm.deleteBase({ name, force: true }),
        `Deleted snapshot "${name}".`,
      );
    },
    [exec],
  );

  const clearInstallerCache = useCallback(async () => {
    await exec(
      "clear-ipsw-cache",
      async () => {
        const result = await window.ade.macosVm.clearIpswCache();
        const gb = result.bytesFreed / (1024 ** 3);
        return gb > 0.01 ? `${gb.toFixed(1)} GB freed` : "cache cleared";
      },
      "Cached macOS installer cleared.",
    );
  }, [exec]);

  const ipAddress = vm.ipAddress ?? null;
  const sshCommand = vm.sshCommand ?? null;
  const sharedPath = vm.guestSharedPath ?? "/Volumes/My Shared Files";
  const runCommand = `ade --socket macos-vm start --lane ${shellQuote(laneId)} --create --text`;
  const bundlePath = typeof vm.metadata.bundlePath === "string" ? vm.metadata.bundlePath : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-[12px] text-fg/85">
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatePill state={stateForPill} label={vm.state.replace(/_/g, " ")} />
              <span className="truncate text-[12px] font-medium text-fg">{vm.name}</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-fg/60">
              lane {vm.laneName} · {running ? `uptime ${uptime}` : `last ran ${formatRelative(vm.lastStoppedAt ?? vm.lastStartedAt)}`}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {running ? (
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium"
                onClick={() => void focusVmWindow()}
                disabled={busy === "focus"}
                aria-label="Bring VM window forward"
              >
                {busy === "focus" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowSquareOut size={13} />}
                Bring VM window forward
              </button>
            ) : (
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium"
                onClick={() => void start()}
                disabled={busy === "start"}
                aria-label="Start VM"
              >
                {busy === "start" ? <SpinnerGap size={13} className="animate-spin" /> : <Play size={13} weight="fill" />}
                Start VM
              </button>
            )}
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
              data-variant="ghost"
              onClick={() => void stop()}
              disabled={!running || busy === "stop"}
              aria-label="Stop VM"
            >
              {busy === "stop" ? <SpinnerGap size={13} className="animate-spin" /> : <Stop size={13} />}
              Stop
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
              data-variant="ghost"
              onClick={openSaveDialog}
              disabled={!stopped || busy === "save-snapshot"}
              title={stopped ? "Save the current VM as a snapshot" : "Stop the VM first to save it as a snapshot"}
              aria-label="Save snapshot"
            >
              {busy === "save-snapshot" ? <SpinnerGap size={13} className="animate-spin" /> : <FloppyDisk size={13} />}
              Save snapshot
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
              data-variant="ghost"
              onClick={() => void restart()}
              disabled={!running || busy === "restart"}
              aria-label="Restart VM"
            >
              {busy === "restart" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowClockwise size={13} />}
              Restart
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] text-muted-fg/70 md:grid-cols-4">
          <div>
            <div className="text-muted-fg/45">CPU</div>
            <div className="text-fg/85">{vm.cpuCores}</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Memory</div>
            <div className="text-fg/85">{vm.memory}</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Disk max</div>
            <div className="text-fg/85">{vm.diskSize}</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Display</div>
            <div className="text-fg/85">{vm.display}</div>
          </div>
          <div className="md:col-span-2">
            <div className="text-muted-fg/45">IP</div>
            <div className="flex items-center gap-1.5 text-fg/85">
              <span className="truncate font-mono">{ipAddress ?? "Not assigned"}</span>
              {ipAddress ? (
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-5 w-5 items-center justify-center rounded text-[10px]"
                  data-variant="ghost"
                  onClick={() => copyText(ipAddress)}
                  aria-label="Copy IP address"
                >
                  <Copy size={11} />
                </button>
              ) : null}
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-muted-fg/45">SSH</div>
            <div className="flex items-center gap-1.5 text-fg/85">
              <span className="truncate font-mono">{sshCommand ?? "Not configured"}</span>
              {sshCommand ? (
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-5 w-5 items-center justify-center rounded text-[10px]"
                  data-variant="ghost"
                  onClick={() => copyText(sshCommand)}
                  aria-label="Copy SSH command"
                >
                  <Copy size={11} />
                </button>
              ) : null}
            </div>
          </div>
          <div className="md:col-span-4">
            <div className="text-muted-fg/45">Share</div>
            <div className="truncate font-mono text-fg/85">{sharedPath}</div>
          </div>
        </div>

        {clonedFromBase ? (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-emerald-300/15 bg-emerald-400/[0.05] px-2 py-1 text-[10px] text-emerald-100/85">
            <CheckCircle size={11} weight="fill" />
            Cloned from snapshot <span className="font-medium">{clonedFromBase.name}</span>
          </div>
        ) : null}

        {message ? (
          <div
            className={cn(
              "mt-3 rounded-md border px-3 py-2 text-[11px] leading-4",
              message.tone === "error"
                ? "border-rose-400/25 bg-rose-500/10 text-rose-100/85"
                : "border-white/[0.08] bg-white/[0.03] text-muted-fg/80",
            )}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.text}
          </div>
        ) : null}
      </div>

      <CockpitDrawer title="Quick input" defaultOpen testId="cockpit-drawer-quick-input">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="ade-input h-8 min-w-0 flex-1 rounded-md px-2 text-[12px]"
              placeholder="Type into VM…"
              value={typeValue}
              onChange={(event) => setTypeValue(event.target.value)}
              disabled={!running}
              aria-label="Text to send to VM"
            />
            <button
              type="button"
              className="ade-shell-control inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px]"
              data-variant="ghost"
              onClick={() => void typeIntoVm()}
              disabled={!running || !typeValue.length || busy === "type"}
              aria-label="Send text"
            >
              {busy === "type" ? <SpinnerGap size={12} className="animate-spin" /> : <Keyboard size={12} />}
              Send
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px]"
              data-variant="ghost"
              onClick={() => void captureScreenshot()}
              disabled={!running || busy === "screenshot"}
              aria-label="Capture screenshot"
            >
              {busy === "screenshot" ? <SpinnerGap size={12} className="animate-spin" /> : <Camera size={12} />}
              Screenshot
            </button>
          </div>
          {screenshotDataUrl ? (
            <div className="relative overflow-hidden rounded-md border border-white/[0.08] bg-black/30">
              <img
                src={screenshotDataUrl}
                alt="macOS VM screenshot"
                className={cn("block max-h-[220px] w-full object-contain", running ? "cursor-crosshair" : "cursor-default")}
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
            <div className="rounded-md border border-dashed border-white/[0.08] bg-black/15 px-3 py-5 text-center text-[11px] text-muted-fg/55">
              No VM screenshot captured yet.
            </div>
          )}
          {screenshotPath ? (
            <div className="truncate font-mono text-[10px] text-muted-fg/45">{screenshotPath}</div>
          ) : null}
          {selectedPoint ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-white/[0.08] bg-black/20 px-2 py-1 font-mono text-[10px] text-muted-fg/70">
                {selectedPoint.x}, {selectedPoint.y}
              </span>
              <button
                type="button"
                className="ade-shell-control inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px]"
                data-variant="ghost"
                onClick={() => void clickSelectedPoint()}
                disabled={!running || busy === "click"}
                aria-label="Click selected point"
              >
                {busy === "click" ? <SpinnerGap size={11} className="animate-spin" /> : <CursorClick size={11} />}
                Click point
              </button>
            </div>
          ) : null}
        </div>
      </CockpitDrawer>

      <CockpitDrawer
        title="Snapshots"
        summary={`${bases.filter((b) => b.state === "ready").length} ready`}
        testId="cockpit-drawer-snapshots"
      >
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="ade-shell-control inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
            data-variant="ghost"
            onClick={openSaveDialog}
            disabled={!stopped || busy === "save-snapshot"}
            title={stopped ? "Save the current VM as a new snapshot" : "Stop the VM first to save it as a snapshot"}
            aria-label="Save current VM as new snapshot"
          >
            <FloppyDisk size={12} />
            + Save current VM as new snapshot
          </button>
          {bases.length === 0 ? (
            <div className="rounded-md border border-dashed border-white/[0.08] px-3 py-3 text-center text-[11px] text-muted-fg/55">
              No snapshots yet.
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {bases.map((base) => {
                const isDefault = status.defaultBase?.id === base.id;
                const ready = base.state === "ready";
                return (
                  <li
                    key={base.id}
                    className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2.5 py-2"
                  >
                    <CheckCircle
                      size={12}
                      weight="fill"
                      className={cn("shrink-0", ready ? "text-emerald-300/80" : "text-muted-fg/35")}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[11px] font-medium text-fg/85">{base.name}</span>
                        {isDefault ? (
                          <span className="rounded-full border border-emerald-300/20 bg-emerald-400/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-100/85">
                            default
                          </span>
                        ) : null}
                        <span className={cn(
                          "rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                          ready
                            ? "border-emerald-300/20 bg-emerald-400/[0.06] text-emerald-100/85"
                            : "border-amber-300/20 bg-amber-400/[0.06] text-amber-100/85",
                        )}>
                          {base.state.replace(/_/g, " ")}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-fg/55">
                        {base.memory} · {base.diskSize} · {formatRelative(base.createdAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded text-[10px]"
                      data-variant="ghost"
                      onClick={() => void renameSnapshot(base.name)}
                      disabled={busy === `rename-${base.name}`}
                      aria-label={`Rename snapshot ${base.name}`}
                    >
                      {busy === `rename-${base.name}` ? <SpinnerGap size={10} className="animate-spin" /> : <PencilSimple size={10} />}
                    </button>
                    <button
                      type="button"
                      className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded text-[10px] text-rose-100/80"
                      data-variant="ghost"
                      onClick={() => void deleteSnapshot(base.name)}
                      disabled={busy === `delete-${base.name}`}
                      aria-label={`Delete snapshot ${base.name}`}
                    >
                      {busy === `delete-${base.name}` ? <SpinnerGap size={10} className="animate-spin" /> : <Trash size={10} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CockpitDrawer>

      <CockpitDrawer title="Resources" testId="cockpit-drawer-resources">
        <div className="grid grid-cols-2 gap-3 text-[11px] text-muted-fg/70 md:grid-cols-4">
          <div>
            <div className="text-muted-fg/45">CPU</div>
            <div className="text-fg/85">{vm.cpuCores} cores</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Memory</div>
            <div className="text-fg/85">{vm.memory}</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Disk max</div>
            <div className="text-fg/85">{vm.diskSize}</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Display</div>
            <div className="text-fg/85">{vm.display}</div>
          </div>
        </div>
        <div className="mt-3 text-[10px] leading-4 text-muted-fg/45">
          Resource changes apply on the next VM start. Stop the VM, edit values, then start again.
        </div>
      </CockpitDrawer>

      <CockpitDrawer title="SSH / IP" testId="cockpit-drawer-ssh">
        <div className="flex flex-col gap-2 text-[11px] text-muted-fg/75">
          <div>
            <div className="text-muted-fg/45">IP address</div>
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-fg/85">{ipAddress ?? "Not assigned"}</span>
              {ipAddress ? (
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded text-[10px]"
                  data-variant="ghost"
                  onClick={() => copyText(ipAddress)}
                  aria-label="Copy IP address"
                >
                  <Copy size={10} />
                </button>
              ) : null}
            </div>
          </div>
          <div>
            <div className="text-muted-fg/45">SSH command</div>
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-fg/85">{sshCommand ?? "Configure SSH inside the VM first."}</span>
              {sshCommand ? (
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded text-[10px]"
                  data-variant="ghost"
                  onClick={() => copyText(sshCommand)}
                  aria-label="Copy SSH command"
                >
                  <Copy size={10} />
                </button>
              ) : null}
            </div>
          </div>
          {!sshCommand ? (
            <div className="rounded-md border border-sky-300/15 bg-sky-400/[0.06] px-2.5 py-2 text-[11px] leading-4 text-sky-50/80">
              Configure SSH inside the VM (System Settings → Sharing → Remote Login) to enable terminal access.
            </div>
          ) : null}
        </div>
      </CockpitDrawer>

      <CockpitDrawer title="Advanced" testId="cockpit-drawer-advanced">
        <div className="flex flex-col gap-3 text-[11px] text-muted-fg/75">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
              data-variant="ghost"
              onClick={() => void focusVmWindow()}
              disabled={!running || busy === "focus"}
              aria-label="Open VM viewer in own window"
            >
              <ArrowSquareOut size={11} />
              Open VM viewer
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
              data-variant="ghost"
              onClick={() => void restart()}
              disabled={!running || busy === "restart"}
              aria-label="Restart VM"
            >
              <ArrowClockwise size={11} />
              Restart
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
              data-variant="ghost"
              onClick={() => {
                if (bundlePath) void window.ade.app.openExternal(`file://${bundlePath}`);
              }}
              disabled={!bundlePath}
              aria-label="Open VM bundle in Finder"
            >
              <FolderOpen size={11} />
              Open bundle in Finder
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] text-rose-100/85"
              data-variant="ghost"
              onClick={() => {
                if (!window.confirm("Delete this lane's VM? Lane files are not removed.")) return;
                void exec("delete-vm", () => window.ade.macosVm.delete({ laneId, force: true }), "VM deleted.");
              }}
              disabled={busy === "delete-vm"}
              aria-label="Delete VM"
            >
              <Trash size={11} />
              Delete VM
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
              data-variant="ghost"
              onClick={() => void clearInstallerCache()}
              disabled={busy === "clear-ipsw-cache"}
              aria-label="Clear cached macOS installer"
            >
              {busy === "clear-ipsw-cache" ? <SpinnerGap size={11} className="animate-spin" /> : <Trash size={11} />}
              Clear cached macOS installer
            </button>
          </div>
          <div className="rounded-md border border-white/[0.06] bg-black/20 px-2.5 py-2 font-mono text-[10px] leading-5 text-muted-fg/65">
            <div className="mb-1 font-sans text-[10px] text-muted-fg/40">Run command</div>
            <div className="break-all">{runCommand}</div>
          </div>
        </div>
      </CockpitDrawer>

      {showSaveDialog ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-6" role="dialog" aria-modal aria-labelledby="save-snapshot-title">
          <div className="w-full max-w-md rounded-lg border border-white/[0.1] bg-[#101012] p-4 shadow-xl">
            <div id="save-snapshot-title" className="text-sm font-medium text-fg">Save VM as snapshot</div>
            <div className="mt-1 text-[11px] text-muted-fg/70">
              Future lane VMs can clone this snapshot in seconds via copy-on-write.
            </div>
            <label className="mt-3 flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-fg/55">Name</span>
              <input
                className="ade-input h-8 rounded-md px-2 text-[12px]"
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
                autoFocus
                aria-label="Snapshot name"
              />
            </label>
            <label className="mt-3 flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-fg/55">Description (optional)</span>
              <input
                className="ade-input h-8 rounded-md px-2 text-[12px]"
                value={saveDescription}
                onChange={(event) => setSaveDescription(event.target.value)}
                aria-label="Snapshot description"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px]"
                data-variant="ghost"
                onClick={() => setShowSaveDialog(false)}
                disabled={busy === "save-snapshot"}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium"
                onClick={() => void confirmSaveSnapshot()}
                disabled={!saveName.trim() || busy === "save-snapshot"}
              >
                {busy === "save-snapshot" ? <SpinnerGap size={11} className="animate-spin" /> : <FloppyDisk size={11} />}
                Save snapshot
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
