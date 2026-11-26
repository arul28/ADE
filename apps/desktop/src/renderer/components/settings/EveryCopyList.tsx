import React from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { LaneLogoMark, laneDisplayColor } from "../terminals/LaneChip";
import { Banner } from "../ui/notice";

/**
 * The parts Archive and Recently deleted share: one list read from every
 * computer with a copy of the project (`useEveryCopyRead`), with a kind
 * filter and a search on top, and a line for each machine that failed or is
 * still reading.
 */

/** "On <machine>" for a row's hover, when the list holds more than one machine. */
export function machineHint(machineCount: number, machineName: string): string | undefined {
  return machineCount > 1 ? `On ${machineName}` : undefined;
}

/** The kind filter with a count on each choice, and the search beside it. */
export function KindFilterSearchBar<K extends string>({
  options,
  value,
  onChange,
  query,
  onQueryChange,
  placeholder,
  searchLabel,
}: {
  options: ReadonlyArray<{ value: K; label: string; count: number }>;
  value: K;
  onChange: (value: K) => void;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  searchLabel: string;
}) {
  return (
    <div className="ade-ar-toolbar">
      <div role="radiogroup" aria-label="Show" className="kit-seg" data-case="sentence">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
            <span className="kit-num ade-ar-count">{option.count}</span>
          </button>
        ))}
      </div>
      <label className="ade-ar-search">
        <MagnifyingGlass size={13} aria-hidden="true" />
        <input
          className="kit-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          aria-label={searchLabel}
        />
      </label>
    </div>
  );
}

/** An error banner, with Try again, for each machine whose read failed. */
export function CopyReadErrors({
  machines,
  reload,
  idPrefix,
  surface,
  title,
}: {
  machines: ReadonlyArray<{ pin: OpenProjectBinding; machineName: string; error: string | null }>;
  reload: (pinKey: string) => void;
  idPrefix: string;
  /** The report's surface name. */
  surface: string;
  title: (machineName: string) => string;
}) {
  return (
    <>
      {machines.map((machine) => (machine.error ? (
        <Banner
          key={machine.pin.key}
          layout="inline"
          model={{
            id: `${idPrefix}-${machine.pin.key}`,
            tone: "error",
            title: title(machine.machineName),
            detail: machine.error,
            actions: [{ label: "Try again", onClick: () => reload(machine.pin.key) }],
            report: { surface, technicalDetail: machine.error },
          }}
        />
      ) : null))}
    </>
  );
}

/** "Still reading …" for the machines that have not answered, once one has. */
export function CopyReadsPending({ machines }: { machines: ReadonlyArray<{ machineName: string; done: boolean }> }) {
  const pending = machines.filter((machine) => !machine.done);
  if (pending.length === 0 || pending.length === machines.length) return null;
  return <p className="ade-modern-muted">Still reading {pending.map((machine) => machine.machineName).join(", ")}…</p>;
}

/** The square at the start of a lane row: the lane mark on the lane's colour. */
export function LaneColorMark({ color }: { color: string | null | undefined }) {
  const shown = laneDisplayColor(color ?? null);
  return (
    <span
      className="ade-ar-mark"
      style={{
        background: `color-mix(in srgb, ${shown} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${shown} 28%, transparent)`,
      }}
    >
      <LaneLogoMark color={shown} size={15} />
    </span>
  );
}
