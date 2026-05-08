import { CaretDown, CheckCircle } from "@phosphor-icons/react";
import type { MacosVmBaseRecord } from "../../../../shared/types";

type Props = {
  bases: MacosVmBaseRecord[];
  value: string | null;
  onChange: (name: string) => void;
  defaultBaseName?: string | null;
  disabled?: boolean;
  ariaLabel?: string;
};

function sortBases(bases: MacosVmBaseRecord[], defaultBaseName: string | null | undefined): MacosVmBaseRecord[] {
  const createdAtTimestamp = (createdAt: string | null | undefined): number => {
    if (!createdAt) return 0;
    const timestamp = Date.parse(createdAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
  };
  const list = [...bases];
  list.sort((a, b) => {
    if (defaultBaseName) {
      if (a.name === defaultBaseName && b.name !== defaultBaseName) return -1;
      if (b.name === defaultBaseName && a.name !== defaultBaseName) return 1;
    }
    const aTime = createdAtTimestamp(a.createdAt);
    const bTime = createdAtTimestamp(b.createdAt);
    return bTime - aTime;
  });
  return list;
}

export function SnapshotPicker({
  bases,
  value,
  onChange,
  defaultBaseName,
  disabled,
  ariaLabel = "Choose snapshot",
}: Props) {
  const ready = bases.filter((b) => b.state === "ready");
  const sorted = sortBases(ready, defaultBaseName ?? null);
  const names = new Set(sorted.map((base) => base.name));
  const selected = value && names.has(value) ? value : sorted[0]?.name ?? "";

  return (
    <div className="relative inline-flex min-w-[220px] items-center">
      <CheckCircle size={13} className="pointer-events-none absolute left-2 text-emerald-300/70" weight="fill" />
      <select
        aria-label={ariaLabel}
        className="ade-input h-8 w-full appearance-none rounded-md pl-7 pr-7 text-[12px]"
        value={selected}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || sorted.length === 0}
      >
        {sorted.length === 0 ? (
          <option value="">No snapshots</option>
        ) : (
          sorted.map((base) => (
            <option key={base.id} value={base.name}>
              {base.name}
              {defaultBaseName && base.name === defaultBaseName ? "\u00A0(default)" : ""}
            </option>
          ))
        )}
      </select>
      <CaretDown size={11} className="pointer-events-none absolute right-2 text-muted-fg/60" />
    </div>
  );
}
