import { memo, useCallback, useRef } from "react";
import { Star, Clock } from "@phosphor-icons/react";
import type { ProviderFamily } from "../../../../shared/modelRegistry";
import { ProviderLogo } from "../ProviderLogos";
import { cn } from "../../ui/cn";

export type RailEntry =
  | { kind: "favorites" }
  | { kind: "recents" }
  | { kind: "provider"; family: ProviderFamily; label: string };

export type AuthStatus = "ok" | "unauthed" | "limited";

export type RailSelection = "favorites" | "recents" | `provider:${ProviderFamily}`;

export type ModelPickerRailProps = {
  entries: readonly RailEntry[];
  selected: RailSelection;
  onSelect: (selection: RailSelection) => void;
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
};

function entryKey(entry: RailEntry): RailSelection {
  if (entry.kind === "favorites") return "favorites";
  if (entry.kind === "recents") return "recents";
  return `provider:${entry.family}`;
}

export const ModelPickerRail = memo(function ModelPickerRail({
  entries,
  selected,
  onSelect,
  providerAuthStatus,
}: ModelPickerRailProps) {
  const buttonRefs = useRef(new Map<RailSelection, HTMLButtonElement>());
  const handleRailKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!(event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")) return;
    event.preventDefault();
    event.stopPropagation();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? Math.max(0, entries.length - 1)
        : Math.min(
            Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)),
            Math.max(0, entries.length - 1),
          );
    const next = entries[nextIndex];
    if (!next) return;
    const nextKey = entryKey(next);
    onSelect(nextKey);
    buttonRefs.current.get(nextKey)?.focus();
  }, [entries, onSelect]);

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      data-model-picker-rail="true"
      className="flex w-12 shrink-0 flex-col gap-0.5 border-r border-white/[0.06] bg-black/[0.18] p-1"
    >
      {entries.map((entry, index) => {
        const key = entryKey(entry);
        const isSelected = selected === key;
        const dot =
          entry.kind === "provider" ? providerAuthStatus?.[entry.family] ?? "ok" : "ok";
        const showDivider =
          index > 0 &&
          (entry.kind === "provider") &&
          entries[index - 1] &&
          entries[index - 1]!.kind !== "provider";
        return (
          <RailButton
            key={key}
            entry={entry}
            selectionKey={key}
            isSelected={isSelected}
            authStatus={dot}
            onSelect={onSelect}
            showDivider={showDivider}
            index={index}
            tabIndex={isSelected ? 0 : -1}
            onKeyDown={handleRailKeyDown}
            refCallback={(node) => {
              if (node) buttonRefs.current.set(key, node);
              else buttonRefs.current.delete(key);
            }}
          />
        );
      })}
    </div>
  );
});

const RailButton = memo(function RailButton({
  entry,
  selectionKey,
  isSelected,
  authStatus,
  onSelect,
  showDivider,
  index,
  tabIndex,
  onKeyDown,
  refCallback,
}: {
  entry: RailEntry;
  selectionKey: RailSelection;
  isSelected: boolean;
  authStatus: AuthStatus;
  onSelect: (selection: RailSelection) => void;
  showDivider: boolean;
  index: number;
  tabIndex: 0 | -1;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => void;
  refCallback: (node: HTMLButtonElement | null) => void;
}) {
  const handleClick = useCallback(() => onSelect(selectionKey), [onSelect, selectionKey]);

  const label =
    entry.kind === "favorites"
      ? "Favorites"
      : entry.kind === "recents"
        ? "Recents"
        : entry.label;

  const icon =
    entry.kind === "favorites" ? (
      <Star size={16} weight={isSelected ? "fill" : "regular"} className="text-amber-400" />
    ) : entry.kind === "recents" ? (
      <Clock size={16} weight={isSelected ? "fill" : "regular"} className="text-fg/80" />
    ) : (
      <ProviderLogo family={entry.family} size={18} />
    );

  const dotColor =
    authStatus === "unauthed"
      ? "bg-red-500"
      : authStatus === "limited"
        ? "bg-amber-400"
        : null;

  return (
    <>
      {showDivider ? <div className="my-0.5 h-px bg-white/[0.05]" aria-hidden /> : null}
      <button
        ref={refCallback}
        type="button"
        role="tab"
        aria-selected={isSelected}
        aria-controls="model-picker-model-list"
        tabIndex={tabIndex}
        aria-label={label}
        title={label}
        data-rail-selection={selectionKey}
        onClick={handleClick}
        onKeyDown={(event) => onKeyDown(event, index)}
        className={cn(
          "relative inline-flex aspect-square w-full items-center justify-center rounded-md transition-colors duration-100",
          isSelected
            ? "bg-white/[0.07] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
            : "text-fg/75 hover:bg-white/[0.04]",
        )}
      >
        {icon}
        {dotColor ? (
          <span
            aria-hidden
            className={cn(
              "absolute right-0.5 top-0.5 inline-block h-1.5 w-1.5 rounded-full ring-1 ring-black/40",
              dotColor,
            )}
          />
        ) : null}
        {isSelected ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -right-1 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-l-full bg-violet-400/80"
          />
        ) : null}
      </button>
    </>
  );
});
