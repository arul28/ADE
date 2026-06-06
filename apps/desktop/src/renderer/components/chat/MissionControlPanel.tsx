import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretRight,
  Check,
  Circle,
  CircleHalf,
  CircleNotch,
  Prohibit,
  Rocket,
  X,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type {
  AgentChatMissionFeature,
  AgentChatMissionState,
} from "../../../shared/types";
import type { MissionSnapshot } from "./chatMission";
import { missionFeatureCounts, orderMissionFeatures } from "./chatMission";

/* ── Mission state chip ── */

const MISSION_STATE_LABEL: Record<string, string> = {
  awaiting_input: "Awaiting input",
  initializing: "Initializing",
  running: "Running",
  paused: "Paused",
  orchestrator_turn: "Planning",
  completed: "Completed",
};

const MISSION_STATE_TONE: Record<string, string> = {
  awaiting_input: "text-amber-200/90 bg-amber-400/10 ring-amber-300/20",
  initializing: "text-cyan-100/90 bg-cyan-400/10 ring-cyan-300/20",
  running: "text-[color:var(--color-accent-bright,#C4B5FD)] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)] ring-[color:color-mix(in_srgb,var(--color-accent)_28%,transparent)]",
  orchestrator_turn: "text-[color:var(--color-accent-bright,#C4B5FD)] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)] ring-[color:color-mix(in_srgb,var(--color-accent)_28%,transparent)]",
  paused: "text-amber-200/90 bg-amber-400/10 ring-amber-300/20",
  completed: "text-emerald-200/90 bg-emerald-400/10 ring-emerald-300/20",
};

function MissionStateChip({ state }: { state: AgentChatMissionState | null }) {
  const key = state ?? "";
  const label = MISSION_STATE_LABEL[key] ?? (state ? state.replace(/_/g, " ") : "Idle");
  const tone = MISSION_STATE_TONE[key] ?? "text-fg/60 bg-white/[0.05] ring-white/10";
  const live = key === "running" || key === "orchestrator_turn";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset", tone)}>
      {live ? (
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current motion-safe:ade-glow-pulse" />
      ) : null}
      {label}
    </span>
  );
}

/* ── Feature status glyph ── */

function FeatureGlyph({ status }: { status: string }) {
  if (status === "completed") {
    return <Check aria-hidden size={14} weight="bold" className="text-emerald-300/90" />;
  }
  if (status === "in_progress") {
    return <CircleHalf aria-hidden size={14} weight="fill" className="text-[color:var(--color-accent,#A78BFA)] motion-safe:ade-glow-pulse" />;
  }
  if (status === "cancelled") {
    return <Prohibit aria-hidden size={14} weight="regular" className="text-rose-300/60" />;
  }
  return <Circle aria-hidden size={14} weight="regular" className="text-fg/30" />;
}

/* ── Feature row ── */

function FeatureRow({
  feature,
  onKillWorker,
  killing,
}: {
  feature: AgentChatMissionFeature;
  onKillWorker?: (workerSessionId: string) => void;
  killing: boolean;
}) {
  const worker = feature.currentWorkerSessionId?.trim() || null;
  const canKill = feature.status === "in_progress" && Boolean(worker) && Boolean(onKillWorker);
  return (
    <div className="group flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-white/[0.03]">
      <span className="mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <FeatureGlyph status={feature.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "break-words font-sans text-[12.5px] leading-5",
            feature.status === "completed" && "text-fg/50",
            feature.status === "cancelled" && "text-fg/40 line-through",
            feature.status === "in_progress" && "text-fg/85",
            feature.status === "pending" && "text-fg/65",
          )}
        >
          {feature.description || feature.id}
        </div>
        {(feature.skillName || feature.milestone || worker) ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-sans text-[10px] text-fg/40">
            {feature.skillName ? <span className="rounded-sm bg-white/[0.05] px-1 py-px tracking-[0.02em]">{feature.skillName}</span> : null}
            {feature.milestone ? <span className="text-amber-300/55">{feature.milestone}</span> : null}
            {worker ? <span className="tabular-nums">worker {worker.slice(-6)}</span> : null}
          </div>
        ) : null}
      </div>
      {canKill && worker ? (
        <button
          type="button"
          onClick={() => onKillWorker?.(worker)}
          disabled={killing}
          title="Stop this worker"
          aria-label="Stop this worker"
          className={cn(
            "mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg/30",
            "opacity-0 transition-all duration-150 hover:bg-rose-400/10 hover:text-rose-300/90 group-hover:opacity-100",
            killing && "opacity-100",
          )}
        >
          {killing ? (
            <CircleNotch aria-hidden size={12} className="animate-spin" />
          ) : (
            <X aria-hidden size={12} weight="bold" />
          )}
        </button>
      ) : null}
    </div>
  );
}

/* ── Progress log ── */

function ProgressLog({ entries }: { entries: MissionSnapshot["progress"] }) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  // Latest first.
  const ordered = [...entries].reverse();
  return (
    <section className="border-t border-white/[0.04] pb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3.5 pb-1 pt-2.5 text-left"
      >
        <span className="flex items-center gap-1.5 font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-fg/45">
          <CaretRight aria-hidden size={10} weight="bold" className={cn("transition-transform duration-150", open && "rotate-90")} />
          Activity
        </span>
        <span className="font-sans text-[10.5px] tabular-nums text-fg/35">{entries.length}</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="log"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden px-3.5"
          >
            {ordered.map((entry, index) => (
              <li key={`${index}-${entry.type}`} className="flex gap-2 py-[3px] font-sans text-[11px] leading-4 text-fg/50">
                <span className="shrink-0 text-fg/35">{entry.type.replace(/_/g, " ")}</span>
                {entry.text ? <span className="min-w-0 flex-1 break-words text-fg/45">{entry.text}</span> : null}
                {entry.workerSessionId ? <span className="shrink-0 tabular-nums text-fg/25">{entry.workerSessionId.slice(-6)}</span> : null}
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

/* ── Main panel ── */

export function MissionControlPanel({
  mission,
  onKillWorker,
  killingWorkerIds,
  className,
}: {
  mission: MissionSnapshot;
  onKillWorker?: (workerSessionId: string) => void;
  killingWorkerIds?: ReadonlySet<string>;
  className?: string;
}) {
  const features = useMemo(() => orderMissionFeatures(mission.features), [mission.features]);
  const counts = useMemo(() => missionFeatureCounts(mission.features), [mission.features]);
  const hasFeatures = features.length > 0;

  return (
    <div className={cn("flex flex-col font-sans", className)}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.04] px-3.5 py-2.5">
        <span className="flex items-center gap-2 font-sans text-[12.5px] font-medium text-fg/80">
          <Rocket aria-hidden size={15} weight="duotone" className="text-[color:var(--color-accent,#A78BFA)]" />
          Mission
        </span>
        <MissionStateChip state={mission.state} />
      </div>

      {/* Feature checklist */}
      <section className="pb-2">
        <div className="flex items-center justify-between px-3.5 pb-1 pt-2.5">
          <span className="font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-fg/45">Features</span>
          {hasFeatures ? (
            <span className="font-sans text-[10.5px] tabular-nums text-fg/35">
              {counts.completed}/{counts.total}
              {counts.inProgress ? ` · ${counts.inProgress} active` : ""}
            </span>
          ) : null}
        </div>
        {hasFeatures ? (
          <div className="space-y-px px-2 pb-1">
            {features.map((feature) => (
              <FeatureRow
                key={feature.id}
                feature={feature}
                onKillWorker={onKillWorker}
                killing={Boolean(feature.currentWorkerSessionId && killingWorkerIds?.has(feature.currentWorkerSessionId))}
              />
            ))}
          </div>
        ) : (
          <p className="px-3.5 pb-2 text-[11.5px] leading-5 text-fg/40">
            No features yet.
            <span className="block pt-0.5 text-fg/25">Droid breaks the mission into features once the run starts.</span>
          </p>
        )}
      </section>

      {/* Activity log */}
      <ProgressLog entries={mission.progress} />
    </div>
  );
}
