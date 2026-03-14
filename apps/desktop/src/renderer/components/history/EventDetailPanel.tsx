import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  CaretDown,
  CaretRight,
  Clock,
  Copy,
  GitBranch,
  Hash,
  Tag,
  X,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import type { TimelineEvent } from "./timelineTypes";
import { getStatusClasses, getEventMeta, CATEGORY_META } from "./eventTaxonomy";
import { relativeWhen, formatDate, formatDurationMs } from "../../lib/format";

/* ─── helpers ─────────────────────────────────────────────────────── */

function shortSha(sha: string | null): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

/* ─── sub-components ──────────────────────────────────────────────── */

function MetaCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-sans text-[10px] font-bold uppercase tracking-[1px] text-muted-fg">
        {label}
      </span>
      <span className="font-mono text-[11px] text-fg">{children}</span>
    </div>
  );
}

function ShaButton({ sha }: { sha: string | null }) {
  if (!sha) return <span className="font-mono text-[11px] text-muted-fg">—</span>;
  return (
    <button
      type="button"
      onClick={() => copyToClipboard(sha)}
      className="group inline-flex items-center gap-1"
      title={`Copy ${sha}`}
    >
      <span className="font-mono text-[11px] text-accent">{shortSha(sha)}</span>
      <Copy
        size={10}
        weight="bold"
        className="text-muted-fg opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

/* ─── main component ──────────────────────────────────────────────── */

type EventDetailPanelProps = {
  event: TimelineEvent | null;
  onClose: () => void;
  onNavigateToLane?: (laneId: string) => void;
};

export function EventDetailPanel({
  event,
  onClose,
  onNavigateToLane,
}: EventDetailPanelProps) {
  const [metadataExpanded, setMetadataExpanded] = useState(false);

  return (
    <AnimatePresence mode="wait">
      {event && (
        <motion.div
          key={event.id}
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 12 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex h-full flex-col overflow-y-auto"
        >
          <PanelContent
            event={event}
            onClose={onClose}
            onNavigateToLane={onNavigateToLane}
            metadataExpanded={metadataExpanded}
            setMetadataExpanded={setMetadataExpanded}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ─── inner content (extracted so hooks are unconditional) ─────────── */

function PanelContent({
  event,
  onClose,
  onNavigateToLane,
  metadataExpanded,
  setMetadataExpanded,
}: {
  event: TimelineEvent;
  onClose: () => void;
  onNavigateToLane?: (laneId: string) => void;
  metadataExpanded: boolean;
  setMetadataExpanded: (v: boolean) => void;
}) {
  const meta = getEventMeta(event.kind);
  const catMeta = CATEGORY_META[event.category];
  const statusClasses = getStatusClasses(event.status);

  return (
    <>
      {/* ── Close button ──────────────────────────────────────── */}
      <div className="flex items-center justify-end p-3 pb-0">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center text-muted-fg transition-colors hover:text-fg"
          aria-label="Close detail panel"
        >
          <X size={14} weight="bold" />
        </button>
      </div>

      {/* ── Header ────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 px-3 pt-2 pb-3">
        <div
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: catMeta.colorMuted }}
        >
          <div
            className="h-[10px] w-[10px]"
            style={{ backgroundColor: catMeta.color }}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="truncate font-sans text-[14px] font-bold leading-tight text-fg">
            {event.label}
          </h2>
          <div
            className={cn(
              "inline-flex w-fit items-center border rounded-md px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px]",
              statusClasses,
            )}
          >
            {event.status}
          </div>
        </div>
      </div>

      {/* ── Description ───────────────────────────────────────── */}
      {meta.description && (
        <div className="px-3 pb-3">
          <p className="font-mono text-[11px] leading-relaxed text-muted-fg">
            {meta.description}
          </p>
        </div>
      )}

      {/* ── Metadata grid ─────────────────────────────────────── */}
      <div className="mx-3 border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl rounded-xl p-3">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <MetaCell label="Kind">
            <span className="font-mono text-[11px] text-fg">{event.kind}</span>
          </MetaCell>

          <MetaCell label="Category">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-[6px] w-[6px]"
                style={{ backgroundColor: catMeta.color }}
              />
              <span className="font-mono text-[11px] text-fg">
                {catMeta.label}
              </span>
            </span>
          </MetaCell>

          <MetaCell label="Status">
            <span
              className={cn(
                "inline-flex items-center border px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-[1px]",
                statusClasses,
              )}
            >
              {event.status}
            </span>
          </MetaCell>

          <MetaCell label="Duration">
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-fg">
              <Clock size={10} weight="bold" className="text-muted-fg" />
              {event.durationMs != null ? formatDurationMs(event.durationMs) : "—"}
            </span>
          </MetaCell>

          <MetaCell label="Started">
            <span className="flex flex-col gap-0.5">
              <span className="font-mono text-[11px] text-fg">
                {formatDate(event.startedAt)}
              </span>
              <span className="font-mono text-[10px] text-muted-fg">
                {relativeWhen(event.startedAt)}
              </span>
            </span>
          </MetaCell>

          <MetaCell label="Ended">
            {event.endedAt ? (
              <span className="flex flex-col gap-0.5">
                <span className="font-mono text-[11px] text-fg">
                  {formatDate(event.endedAt)}
                </span>
                <span className="font-mono text-[10px] text-muted-fg">
                  {relativeWhen(event.endedAt)}
                </span>
              </span>
            ) : (
              <span className="font-mono text-[11px] text-amber-400">
                Running…
              </span>
            )}
          </MetaCell>
        </div>
      </div>

      {/* ── Lane section ──────────────────────────────────────── */}
      {event.laneId && (
        <div className="mx-3 mt-3 border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl rounded-xl p-3">
          <span className="font-sans text-[10px] font-bold uppercase tracking-[1px] text-muted-fg">
            Lane
          </span>
          <div className="mt-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-block h-3 w-[3px]"
                style={{ backgroundColor: catMeta.color }}
              />
              <span className="font-mono text-[11px] text-fg">
                {event.laneName ?? event.laneId}
              </span>
            </span>
            {onNavigateToLane && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigateToLane(event.laneId!)}
              >
                <span className="inline-flex items-center gap-1">
                  Open Lane
                  <ArrowSquareOut size={10} weight="bold" />
                </span>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── SHA transition ────────────────────────────────────── */}
      {(event.preHeadSha || event.postHeadSha) && (
        <div className="mx-3 mt-3 border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl rounded-xl p-3">
          <span className="font-sans text-[10px] font-bold uppercase tracking-[1px] text-muted-fg">
            HEAD Transition
          </span>
          <div className="mt-2 flex items-center gap-2">
            <GitBranch size={12} weight="bold" className="text-muted-fg" />
            <ShaButton sha={event.preHeadSha} />
            <ArrowRight size={10} weight="bold" className="text-muted-fg" />
            <ShaButton sha={event.postHeadSha} />
          </div>
        </div>
      )}

      {/* ── Raw metadata (collapsible) ────────────────────────── */}
      {event.metadata && Object.keys(event.metadata).length > 0 && (
        <div className="mx-3 mt-3 border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl rounded-xl p-3">
          <button
            type="button"
            onClick={() => setMetadataExpanded(!metadataExpanded)}
            className="flex w-full items-center gap-1.5 text-left"
          >
            {metadataExpanded ? (
              <CaretDown size={10} weight="bold" className="text-muted-fg" />
            ) : (
              <CaretRight size={10} weight="bold" className="text-muted-fg" />
            )}
            <span className="font-sans text-[10px] font-bold uppercase tracking-[1px] text-muted-fg">
              Raw Metadata
            </span>
          </button>

          <AnimatePresence initial={false}>
            {metadataExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.12, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <pre className="mt-2 overflow-x-auto border border-white/[0.04] bg-white/[0.02] rounded-lg p-3 font-mono text-[10px] leading-relaxed text-muted-fg">
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ── Action buttons ────────────────────────────────────── */}
      <div className="mt-auto flex flex-wrap items-center gap-2 p-3 pt-4">
        {event.laneId && onNavigateToLane && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigateToLane(event.laneId!)}
          >
            <span className="inline-flex items-center gap-1">
              <ArrowSquareOut size={10} weight="bold" />
              Open Lane
            </span>
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => copyToClipboard(event.id)}
        >
          <span className="inline-flex items-center gap-1">
            <Hash size={10} weight="bold" />
            Copy Event ID
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            copyToClipboard(
              JSON.stringify(
                { ...event, metadataJson: undefined },
                null,
                2,
              ),
            )
          }
        >
          <span className="inline-flex items-center gap-1">
            <Copy size={10} weight="bold" />
            Export JSON
          </span>
        </Button>
      </div>
    </>
  );
}
