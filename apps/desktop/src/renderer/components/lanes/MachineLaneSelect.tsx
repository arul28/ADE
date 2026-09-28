import { CaretUpDown } from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "./laneDesignTokens";

/**
 * The lane dropdown shared by Files and History: one accent-tinted select that
 * lists every lane, grouped under a heading per machine once the project spans
 * more than one. The lane implies its machine, so picking a lane is the only
 * way either surface moves between machines — there is no separate switch.
 */

export type MachineLaneSelectOption = {
  /** Opaque value the host decodes. */
  value: string;
  label: string;
  title?: string;
};

export type MachineLaneSelectGroup = {
  key: string;
  /** Machine name, e.g. "This computer" or "Arul’s Mac Studio". */
  machineName: string;
  online: boolean;
  /** Why nothing here can be opened ("Mac Studio is offline"), or null. */
  disabledReason: string | null;
  options: MachineLaneSelectOption[];
};

/** "name · branch", the one label format both lane pickers use. */
export function laneOptionLabel(lane: { name: string; branchRef?: string | null; kind?: string | null }): string {
  const branch = (lane.branchRef ?? "").replace(/^refs\/heads\//, "") || lane.kind || "worktree";
  return `${lane.name} · ${branch}`;
}

export function MachineLaneSelect({
  value,
  groups,
  onChange,
  placeholder,
  title,
  className,
}: {
  value: string;
  /** One group lists flat (no heading); two or more list under machine headings. */
  groups: MachineLaneSelectGroup[];
  onChange: (value: string) => void;
  /** An empty first option, e.g. "Select lane…". */
  placeholder?: string;
  title?: string;
  className?: string;
}) {
  const optionStyle = { color: COLORS.textPrimary, background: COLORS.cardBgSolid };
  const renderOptions = (group: MachineLaneSelectGroup) =>
    group.options.map((option) => (
      <option
        key={option.value}
        value={option.value}
        disabled={group.disabledReason != null}
        title={group.disabledReason ?? option.title ?? option.label}
        style={optionStyle}
      >
        {option.label}
      </option>
    ));
  return (
    <div className={`relative flex min-w-0 flex-1 items-center ${className ?? ""}`}>
      <select
        value={value}
        title={title}
        aria-label="Lane"
        onChange={(event) => onChange(event.target.value)}
        className="w-full appearance-none truncate rounded-md py-1 pl-2 pr-6 text-xs outline-none"
        style={{
          fontFamily: MONO_FONT,
          fontWeight: 600,
          color: "var(--color-accent-bright)",
          background: COLORS.accentSubtle,
          border: `1px solid ${COLORS.accentBorder}`,
          cursor: "pointer",
        }}
      >
        {placeholder != null ? (
          <option value="" style={optionStyle}>{placeholder}</option>
        ) : null}
        {groups.length > 1
          ? groups.map((group) => (
            <optgroup
              key={group.key}
              label={group.online && !group.disabledReason ? group.machineName : `${group.machineName} · offline`}
            >
              {renderOptions(group)}
            </optgroup>
          ))
          : groups.flatMap(renderOptions)}
      </select>
      <CaretUpDown size={12} color={COLORS.accent} style={{ position: "absolute", right: 6, pointerEvents: "none" }} />
    </div>
  );
}
