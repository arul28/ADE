import { useCallback, useState } from "react";
import { motion, useDragControls, useMotionValue } from "motion/react";
import { X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { EMPHASIZED_EASE, exitTransition } from "../../lib/motion";
import { workToolDefinition } from "../terminals/workTools";
import { cn } from "../ui/cn";
import { WorkLiveIosStreamView } from "./WorkLiveIosStreamView";
import {
  workLiveCardSize,
  workLiveIosCaption,
  type WorkLiveIosDevice,
} from "./workLiveCard";

const ENTER = { duration: 0.2, ease: EMPHASIZED_EASE } as const;

/**
 * One Apple-device live card: H.264 stream, recording dot, Float (PiP), Open.
 *
 * Clicking the picture opens the Apple column. The card never injects input.
 */
export function WorkLiveIosCornerCard({
  device,
  runtimePin,
  origin,
  offset,
  reduceMotion,
  onPick,
  onDismiss,
  pipRequestKey,
}: {
  device: WorkLiveIosDevice;
  runtimePin: OpenProjectBinding | null;
  origin: { left: number; top: number };
  offset: number;
  reduceMotion: boolean;
  onPick: () => void;
  onDismiss: () => void;
  pipRequestKey: number;
}) {
  const definition = workToolDefinition("ios");
  const hue = definition?.color ?? "#60a5fa";
  const Icon = definition?.icon;
  const size = workLiveCardSize("ios");
  const [pipActive, setPipActive] = useState(false);
  const identity = workLiveIosCaption(device) ?? definition?.label ?? "Simulator";
  const ownerLabel = device.chatSessionId ? "agent" : null;
  const recording = device.recording;
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const dragControls = useDragControls();

  const activate = useCallback(() => {
    onPick();
  }, [onPick]);

  const width = pipActive ? 220 : size.width;
  const height = pipActive ? 32 : size.height;

  return (
    <motion.section
      aria-label={`${identity} live preview`}
      drag
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      dragElastic={0}
      style={{
        x: dragX,
        y: dragY,
        left: origin.left - offset * 16,
        top: origin.top - offset * 16,
        width,
        height,
      }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
      onDragStart={() => {
        // Drag is visual only for a device card; dropping it does not persist
        // a second position next to the browser card's stored corner.
      }}
      onDragEnd={() => {
        dragX.set(0);
        dragY.set(0);
      }}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      exit={reduceMotion
        ? { opacity: 0, transition: { duration: 0 } }
        : { opacity: 0, scale: 0.97, transition: exitTransition }}
      transition={reduceMotion ? { duration: 0 } : ENTER}
      data-work-live-card="ios"
      data-work-live-device={device.udid}
      data-work-live-pip={pipActive ? "true" : undefined}
      className={cn(
        "group pointer-events-auto absolute cursor-pointer overflow-hidden",
        "select-none",
        "rounded-[var(--radius-lg)] bg-[var(--color-surface)] shadow-[var(--shadow-float)]",
        "transition-shadow duration-[120ms] ease-out motion-reduce:transition-none",
        "hover:shadow-[var(--shadow-card-hover)]",
      )}
      onClick={activate}
    >
      <div
        className={pipActive
          ? "pointer-events-none fixed left-[-9999px] top-0 h-[320px] w-[240px]"
          : "absolute inset-0"}
      >
        <WorkLiveIosStreamView
          device={device}
          runtimePin={runtimePin}
          onScreen={!pipActive}
          pipActive={pipActive}
          onPipChange={setPipActive}
          pipRequestKey={pipRequestKey}
        />
      </div>

      {pipActive ? (
        <div className="relative z-[1] flex h-full items-center gap-2 px-2 text-[11px] font-medium text-fg">
          {Icon ? <Icon size={14} weight="duotone" style={{ color: hue }} /> : null}
          <span className="min-w-0 truncate">{identity}</span>
          {ownerLabel ? <span className="text-muted-fg"> · {ownerLabel}</span> : null}
          {recording ? (
            <span
              title="Recording"
              data-live-card-status="recording"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: "var(--color-error)" }}
            />
          ) : null}
        </div>
      ) : (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_var(--chat-glass-border)]"
          />
          <span
            aria-hidden="true"
            data-live-card-status={recording ? "recording" : "idle"}
            title={recording ? "Recording" : undefined}
            className={cn(
              "pointer-events-none absolute right-2 top-2 h-2 w-2 rounded-full",
              "shadow-[0_0_0_1px_rgba(0,0,0,0.45)]",
              "transition-opacity duration-[120ms] ease-out motion-reduce:transition-none",
              "group-hover:opacity-0 group-focus-within:opacity-0",
              recording ? "[animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none" : "bg-fg/25",
            )}
            style={recording ? { background: "var(--color-error)" } : undefined}
          />
          <div
            data-live-card-pill=""
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              dragControls.start(event);
            }}
            className={cn(
              "absolute inset-x-2 top-2 z-[1] flex h-8 items-center gap-2 rounded-[10px] px-2",
              "border border-[var(--chat-glass-border)] bg-[var(--chat-glass-bg)]",
              "backdrop-blur-[var(--blur-popup)] shadow-[var(--shadow-popup)]",
              "cursor-grab active:cursor-grabbing",
              "pointer-events-none opacity-0 transition-opacity duration-[120ms] ease-out",
              "group-hover:pointer-events-auto group-hover:opacity-100",
              "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
              "motion-reduce:transition-none",
            )}
          >
            {Icon ? <Icon size={14} weight="duotone" className="shrink-0" style={{ color: hue }} /> : null}
            <span className="min-w-0 shrink truncate text-[11px] font-medium text-fg" title={identity}>
              {identity}
              {ownerLabel ? <span className="text-muted-fg"> · {ownerLabel}</span> : null}
            </span>
            {recording ? (
              <span
                title="Recording"
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full [animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none"
                style={{ background: "var(--color-error)" }}
              />
            ) : (
              <span className="shrink-0 text-[9.5px] font-medium tracking-[0.2px] text-muted-fg/70">
                Live
              </span>
            )}
            <button
              type="button"
              data-live-card-inert=""
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDismiss();
              }}
              title="Hide until the next activity"
              aria-label={`Hide the ${identity} preview`}
              className={cn(
                "-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px]",
                "text-muted-fg/80 transition-colors duration-[120ms] motion-reduce:transition-none",
                "hover:bg-white/[0.08] hover:text-fg",
                "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
              )}
            >
              <X size={11} weight="bold" />
            </button>
          </div>
        </>
      )}
    </motion.section>
  );
}
