import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ArrowClockwise, Crosshair, DeviceMobile, Play } from "@phosphor-icons/react";
import type {
  IosElementContextItem,
  IosSimulatorDevice,
  IosSimulatorFrame,
  IosSimulatorInspectResult,
  IosSimulatorScreenshot,
  IosSimulatorStatus,
  IosSimulatorStreamStatus,
} from "../../../shared/types";
import { cn } from "../ui/cn";

type SimulatorMode = "control" | "select";

type ChatIosSimulatorPanelProps = {
  sessionId: string | null;
  contextItems: IosElementContextItem[];
  onAddContext: (item: IosElementContextItem) => void;
  onRemoveContext: (id: string) => void;
};

function toolDetail(status: IosSimulatorStatus | null, name: string): string {
  return status?.tools.find((tool) => tool.name === name)?.detail ?? "";
}

function deviceLabel(device: IosSimulatorDevice | null | undefined): string {
  if (!device) return "No simulator";
  return `${device.name} · ${device.runtime} · ${device.state}`;
}

function contextLabel(item: IosElementContextItem): string {
  const file = item.sourceFile ? item.sourceFile.split("/").pop() : null;
  const line = item.sourceLine ? `:${item.sourceLine}` : "";
  return file ? `${item.componentId} · ${file}${line}` : item.componentId;
}

type RenderedImageBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
};

export function ChatIosSimulatorPanel({
  sessionId,
  contextItems,
  onAddContext,
  onRemoveContext,
}: ChatIosSimulatorPanelProps) {
  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [devices, setDevices] = useState<IosSimulatorDevice[]>([]);
  const [selectedDeviceUdid, setSelectedDeviceUdid] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<IosSimulatorScreenshot | null>(null);
  const [liveFrame, setLiveFrame] = useState<IosSimulatorFrame | null>(null);
  const [streamStatus, setStreamStatus] = useState<IosSimulatorStreamStatus | null>(null);
  const [mode, setMode] = useState<SimulatorMode>("select");
  const [hoveredItem, setHoveredItem] = useState<IosElementContextItem | null>(null);
  const [hoverMessage, setHoverMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const imageBoundsRef = useRef<RenderedImageBounds | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverRequestSeqRef = useRef(0);

  const activeDevice = useMemo(() => {
    if (selectedDeviceUdid) return devices.find((device) => device.udid === selectedDeviceUdid) ?? null;
    return status?.activeDevice ?? devices[0] ?? null;
  }, [devices, selectedDeviceUdid, status?.activeDevice]);

  const refreshStatus = useCallback(async () => {
    const [nextStatus, nextDevices] = await Promise.all([
      window.ade.iosSimulator.getStatus(),
      window.ade.iosSimulator.listDevices(),
    ]);
    setStatus(nextStatus);
    setDevices(nextDevices);
    setSelectedDeviceUdid((current) => current ?? nextStatus.activeDevice?.udid ?? nextDevices[0]?.udid ?? null);
  }, []);

  const refreshScreenshot = useCallback(async () => {
    const deviceUdid = selectedDeviceUdid ?? status?.activeDevice?.udid ?? undefined;
    const next = await window.ade.iosSimulator.screenshot({ deviceUdid });
    setScreenshot(next);
  }, [selectedDeviceUdid, status?.activeDevice?.udid]);

  const startPreviewStream = useCallback(async () => {
    const deviceUdid = selectedDeviceUdid ?? status?.activeDevice?.udid ?? undefined;
    const next = await window.ade.iosSimulator.startStream({ deviceUdid, fps: 2, backend: "simctl-screenshot-poll" });
    setStreamStatus(next);
    setMessage(next.running ? "Simulator preview started with Xcode simctl screenshots." : next.lastError);
  }, [selectedDeviceUdid, status?.activeDevice?.udid]);

  const startLowLatencyStream = useCallback(async () => {
    const deviceUdid = selectedDeviceUdid ?? status?.activeDevice?.udid ?? undefined;
    const next = await window.ade.iosSimulator.startStream({ deviceUdid, fps: 30, backend: "idb-h264-ffmpeg-mjpeg" });
    setStreamStatus(next);
    setMessage(next.running ? "Low-latency simulator stream started through idb." : next.lastError);
  }, [selectedDeviceUdid, status?.activeDevice?.udid]);

  useEffect(() => {
    void refreshStatus().catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshStatus]);

  useEffect(() => {
    if (!activeDevice) return;
    if (streamStatus?.running) return;
    void refreshScreenshot().catch(() => {});
    const timer = window.setInterval(() => {
      void refreshScreenshot().catch(() => {});
    }, 1200);
    return () => window.clearInterval(timer);
  }, [activeDevice, refreshScreenshot, refreshToken, streamStatus?.running]);

  useEffect(() => {
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      if (event.type === "stream-frame") {
        setLiveFrame((current) => {
          if (selectedDeviceUdid && event.frame.deviceUdid !== selectedDeviceUdid) return current;
          return event.frame;
        });
      } else if (event.type === "stream-started" || event.type === "stream-stopped" || event.type === "stream-error") {
        setStreamStatus(event.status);
        if (event.type === "stream-error" && event.status.lastError) {
          setMessage(event.status.lastError);
        }
      }
    });
    void window.ade.iosSimulator.getStreamStatus().then(setStreamStatus).catch(() => {});
    return unsubscribe;
  }, [selectedDeviceUdid]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current != null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const idbAvailable = status?.tools.find((tool) => tool.name === "idb")?.available ?? false;
  const idbCompanionAvailable = status?.tools.find((tool) => tool.name === "idb_companion")?.available ?? false;
  const ffmpegAvailable = status?.tools.find((tool) => tool.name === "ffmpeg")?.available ?? false;
  const controlToolsAvailable = idbAvailable && idbCompanionAvailable;
  const lowLatencyStreamAvailable = controlToolsAvailable && ffmpegAvailable;

  const launch = useCallback(async () => {
    setBusy(true);
    setMessage("Building and launching ADE iOS...");
    try {
      const session = await window.ade.iosSimulator.launch({
        deviceUdid: selectedDeviceUdid,
        chatSessionId: sessionId,
        build: true,
        mode: "snapshot",
      });
      setSelectedDeviceUdid(session.deviceUdid);
      await refreshStatus();
      await refreshScreenshot();
      setMessage("ADE iOS is running in snapshot + inspector mode. Start preview for a built-in live-ish view.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refreshScreenshot, refreshStatus, selectedDeviceUdid, sessionId]);

  const measureImagePoint = useCallback((event: MouseEvent<HTMLImageElement>): { x: number; y: number; bounds: RenderedImageBounds } | null => {
    const img = imageRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0 || rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const renderedWidth = img.naturalWidth * scale;
    const renderedHeight = img.naturalHeight * scale;
    const renderedLeft = rect.left + ((rect.width - renderedWidth) / 2);
    const renderedTop = rect.top + ((rect.height - renderedHeight) / 2);
    if (
      event.clientX < renderedLeft
      || event.clientX > renderedLeft + renderedWidth
      || event.clientY < renderedTop
      || event.clientY > renderedTop + renderedHeight
    ) {
      return null;
    }
    const parentRect = img.parentElement?.getBoundingClientRect() ?? rect;
    const bounds = {
      left: renderedLeft - parentRect.left,
      top: renderedTop - parentRect.top,
      width: renderedWidth,
      height: renderedHeight,
      scale,
    };
    imageBoundsRef.current = bounds;
    return {
      x: (event.clientX - renderedLeft) / scale,
      y: (event.clientY - renderedTop) / scale,
      bounds,
    };
  }, []);

  const scheduleHoverInspect = useCallback((x: number, y: number) => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = window.setTimeout(() => {
      const seq = hoverRequestSeqRef.current + 1;
      hoverRequestSeqRef.current = seq;
      void window.ade.iosSimulator.inspectPoint({
        deviceUdid: selectedDeviceUdid,
        x,
        y,
      }).then((result: IosSimulatorInspectResult) => {
        if (hoverRequestSeqRef.current !== seq) return;
        setHoveredItem(result.item);
        setHoverMessage(result.item ? null : "No annotated SwiftUI element here.");
      }).catch((error) => {
        if (hoverRequestSeqRef.current !== seq) return;
        setHoveredItem(null);
        setHoverMessage(error instanceof Error ? error.message : String(error));
      });
    }, 70);
  }, [selectedDeviceUdid]);

  const handleImageMove = useCallback((event: MouseEvent<HTMLImageElement>) => {
    if (mode !== "select") return;
    const point = measureImagePoint(event);
    if (!point) {
      setHoveredItem(null);
      setHoverMessage(null);
      return;
    }
    scheduleHoverInspect(point.x, point.y);
  }, [measureImagePoint, mode, scheduleHoverInspect]);

  const handleImageLeave = useCallback(() => {
    setHoveredItem(null);
    setHoverMessage(null);
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleImageClick = useCallback(async (event: MouseEvent<HTMLImageElement>) => {
    const point = measureImagePoint(event);
    if (!point) return;
    setBusy(true);
    try {
      if (mode === "control") {
        await window.ade.iosSimulator.tap({ deviceUdid: selectedDeviceUdid, x: point.x, y: point.y });
        setRefreshToken((value) => value + 1);
        setMessage(null);
      } else {
        const result = await window.ade.iosSimulator.selectPoint({ deviceUdid: selectedDeviceUdid, x: point.x, y: point.y });
        onAddContext(result.item);
        setMessage(result.source === "ade-inspector" ? "Added SwiftUI element context." : "Added simulator coordinate context.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [measureImagePoint, mode, onAddContext, selectedDeviceUdid]);

  const streamRunning = streamStatus?.running === true;
  const displayImage = liveFrame?.dataUrl && streamRunning ? liveFrame : screenshot;
  const hoverBounds = hoveredItem?.frame && imageBoundsRef.current
    ? {
      left: imageBoundsRef.current.left + (hoveredItem.frame.x * imageBoundsRef.current.scale),
      top: imageBoundsRef.current.top + (hoveredItem.frame.y * imageBoundsRef.current.scale),
      width: Math.max(1, hoveredItem.frame.width * imageBoundsRef.current.scale),
      height: Math.max(1, hoveredItem.frame.height * imageBoundsRef.current.scale),
    }
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <select
            className="min-w-0 flex-1 rounded-md border border-white/[0.07] bg-black/20 px-2 py-1.5 font-sans text-[11px] text-fg/75 outline-none"
            value={activeDevice?.udid ?? ""}
            onChange={(event) => setSelectedDeviceUdid(event.currentTarget.value || null)}
          >
            {devices.length ? devices.map((device) => (
              <option key={device.udid} value={device.udid}>
                {deviceLabel(device)}
              </option>
            )) : (
              <option value="">No available simulator</option>
            )}
          </select>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/[0.07] bg-white/[0.03] text-fg/55 transition-colors hover:text-fg/85"
            onClick={() => {
              void refreshStatus().then(refreshScreenshot).catch((error) => {
                setMessage(error instanceof Error ? error.message : String(error));
              });
            }}
            title="Refresh simulator"
          >
            <ArrowClockwise size={14} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2 font-sans text-[11px] font-medium text-emerald-100/85 transition-colors hover:bg-emerald-500/15"
            disabled={busy || !status?.supported}
            onClick={() => void launch()}
          >
            <Play size={13} weight="fill" />
            Launch
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 font-sans text-[11px] font-medium transition-colors",
              streamRunning
                ? "border-cyan-300/20 bg-cyan-500/12 text-cyan-100/85"
                : "border-white/[0.07] bg-white/[0.03] text-fg/55 hover:text-fg/85",
            )}
            disabled={busy || !status?.supported}
            onClick={() => {
              if (streamRunning) {
                void window.ade.iosSimulator.stopStream().then((next) => {
                  setStreamStatus(next);
                  setLiveFrame(null);
                  setMessage("Simulator preview stopped.");
                }).catch((error) => {
                  setMessage(error instanceof Error ? error.message : String(error));
                });
              } else {
                setBusy(true);
                void startPreviewStream().catch((error) => {
                  setMessage(error instanceof Error ? error.message : String(error));
                }).finally(() => setBusy(false));
              }
            }}
            title={streamRunning ? "Stop preview" : "Start simctl preview"}
          >
            <DeviceMobile size={12} weight={streamRunning ? "fill" : "regular"} />
            {streamRunning ? "Stop" : "Preview"}
          </button>
          {lowLatencyStreamAvailable && !streamRunning ? (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 font-sans text-[11px] font-medium text-fg/55 transition-colors hover:text-fg/85"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void startLowLatencyStream().catch((error) => {
                  setMessage(error instanceof Error ? error.message : String(error));
                }).finally(() => setBusy(false));
              }}
              title="Start low-latency idb stream"
            >
              <DeviceMobile size={12} />
              Live
            </button>
          ) : null}
          <div className="flex rounded-md border border-white/[0.07] bg-white/[0.02] p-0.5">
            <button
              type="button"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium transition-colors",
                mode === "select" ? "bg-cyan-500/15 text-cyan-100/85" : "text-muted-fg/45 hover:text-fg/70",
              )}
              onClick={() => setMode("select")}
            >
              <Crosshair size={12} />
              Select
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium transition-colors",
                mode === "control" ? "bg-violet-500/15 text-violet-100/85" : "text-muted-fg/45 hover:text-fg/70",
                !controlToolsAvailable ? "cursor-not-allowed opacity-45" : null,
              )}
              disabled={!controlToolsAvailable}
              onClick={() => setMode("control")}
              title={controlToolsAvailable ? "Tap through idb" : "Install idb and idb_companion for direct control"}
            >
              <DeviceMobile size={12} />
              Control
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-white/[0.08] bg-black/35">
        {displayImage?.dataUrl ? (
          <>
            <img
              ref={imageRef}
              src={displayImage.dataUrl}
              alt="iOS Simulator"
              className={cn(
                "h-full w-full object-contain",
                mode === "select" ? "cursor-crosshair" : "cursor-pointer",
              )}
              draggable={false}
              onClick={handleImageClick}
              onMouseMove={handleImageMove}
              onMouseLeave={handleImageLeave}
            />
            {hoverBounds && hoveredItem ? (
              <div
                className="pointer-events-none absolute rounded-md border border-cyan-200/70 bg-cyan-400/10 shadow-[0_0_0_1px_rgba(8,145,178,0.35),0_0_24px_rgba(34,211,238,0.18)]"
                style={{
                  left: hoverBounds.left,
                  top: hoverBounds.top,
                  width: hoverBounds.width,
                  height: hoverBounds.height,
                }}
              >
                <div className="absolute left-0 top-0 max-w-[220px] -translate-y-full rounded-t-md border border-cyan-200/30 bg-black/80 px-1.5 py-0.5 font-sans text-[10px] text-cyan-50/85">
                  {contextLabel(hoveredItem)}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2 text-center text-muted-fg/45">
            <DeviceMobile size={28} />
            <div className="font-sans text-[12px]">Launch ADE iOS or refresh a booted simulator.</div>
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-2">
        {message ? (
          <div className="rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5 font-sans text-[11px] text-muted-fg/70">
            {message}
          </div>
        ) : null}
        {!controlToolsAvailable ? (
          <div className="rounded-md border border-amber-400/15 bg-amber-500/10 px-2 py-1.5 font-sans text-[11px] text-amber-100/70">
            Direct tap/text control needs idb and idb_companion. Preview still works through Xcode simctl. {toolDetail(status, "idb")} {toolDetail(status, "idb_companion")}
          </div>
        ) : null}
        {streamRunning ? (
          <div className="rounded-md border border-cyan-300/12 bg-cyan-500/10 px-2 py-1.5 font-sans text-[11px] text-cyan-50/70">
            {streamStatus?.backend === "idb-h264-ffmpeg-mjpeg" ? "Live via idb" : "Preview via simctl"} · {streamStatus?.frameCount ?? 0} frames
          </div>
        ) : null}
        {hoverMessage && mode === "select" ? (
          <div className="rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5 font-sans text-[11px] text-muted-fg/55">
            {hoverMessage}
          </div>
        ) : null}
        {contextItems.length ? (
          <div className="space-y-1.5">
            <div className="font-sans text-[10px] font-medium uppercase text-muted-fg/35">Added to chat</div>
            {contextItems.map((item) => (
              <div key={item.id} className="flex items-center gap-2 rounded-md border border-cyan-300/15 bg-cyan-500/10 px-2 py-1.5">
                <div className="min-w-0 flex-1 truncate font-sans text-[11px] text-cyan-50/80">
                  {contextLabel(item)}
                </div>
                <button
                  type="button"
                  className="font-sans text-[10px] text-cyan-100/45 transition-colors hover:text-cyan-100/80"
                  onClick={() => onRemoveContext(item.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
