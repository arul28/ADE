import { memo, useCallback, useRef } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { ProviderLogo } from "../../shared/ProviderLogos";
import type { ReachableGroup } from "./harnessReach";

/**
 * The Custom provider wizard's source rail.
 *
 * One row per provider the harness could draw on — this computer's account
 * sign-ins, an OpenCode sign-in or stored key, a subscription borrowed through
 * ADE's proxy. Selecting a row scopes the model pane beside it; the blank
 * model pane that used to list every source in one scroll is exactly what this
 * replaces. It mirrors the composer's model picker, whose rail scopes its list
 * the same way.
 *
 * A source that can serve nothing for this harness stays in the rail with a
 * warning mark rather than disappearing: hiding it is what made "why can't I
 * use my ChatGPT sign-in here" unanswerable on screen. The pane shows its
 * models and the reason.
 */
export const CustomProviderSourceRail = memo(function CustomProviderSourceRail({
  groups,
  activeKey,
  onSelect,
}: {
  groups: readonly ReachableGroup[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (!(event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")) return;
      event.preventDefault();
      event.stopPropagation();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? groups.length - 1
            : Math.min(Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)), groups.length - 1);
      const next = groups[nextIndex];
      if (!next) return;
      onSelect(next.key);
      buttonRefs.current.get(next.key)?.focus();
    },
    [groups, onSelect],
  );

  if (groups.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Model source"
      data-custom-source-rail=""
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        width: 196,
        flexShrink: 0,
        overflowY: "auto",
        padding: 6,
        borderRight: `1px solid ${COLORS.borderMuted}`,
      }}
    >
      {groups.map((group, index) => {
        const selected = group.key === activeKey;
        const servesNothing = group.models.length === 0 && group.unreachable.length > 0;
        const reason = servesNothing ? group.unreachable[0]?.reason ?? null : null;
        return (
          <button
            key={group.key}
            ref={(node) => {
              if (node) buttonRefs.current.set(group.key, node);
              else buttonRefs.current.delete(group.key);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="custom-provider-model-pane"
            tabIndex={selected ? 0 : -1}
            title={reason ?? undefined}
            data-custom-source={group.key}
            onClick={() => onSelect(group.key)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 8px",
              borderRadius: 8,
              textAlign: "left",
              cursor: "pointer",
              fontFamily: SANS_FONT,
              border: `1px solid ${selected ? COLORS.accentBorder : "transparent"}`,
              background: selected ? COLORS.accentSubtle : "transparent",
            }}
          >
            <ProviderLogo family={group.logoProvider} size={14} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 600,
                  color: COLORS.textPrimary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {group.label}
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 10,
                  lineHeight: 1.4,
                  color: COLORS.textMuted,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {group.detail}
              </span>
            </span>
            {servesNothing ? (
              <WarningCircle size={12} color={COLORS.warning} weight="fill" aria-label="Cannot run in this harness" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
});
