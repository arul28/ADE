import { memo, useCallback } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Star, Lightning } from "@phosphor-icons/react";
import type { ModelDescriptor } from "../../../../shared/modelRegistry";
import { ModelRowLogo } from "../ProviderLogos";
import { cn } from "../../ui/cn";

const LOCAL_FAMILIES = new Set(["ollama", "lmstudio"]);

function isLocalModel(model: ModelDescriptor): boolean {
  return LOCAL_FAMILIES.has(model.family) || model.authTypes.includes("local");
}

function cursorAvailabilityBadge(model: ModelDescriptor): string | null {
  if (model.family !== "cursor") return null;
  const availability = model.cursorAvailability;
  if (!availability) return null;
  if (availability.cli && !availability.sdk) return "CLI only";
  if (availability.sdk && !availability.cli) return "Chat only";
  return null;
}

function subProviderLabel(model: ModelDescriptor): string | null {
  const sub = (model as ModelDescriptor & { subProvider?: string }).subProvider;
  if (typeof sub === "string" && sub.trim().length) return sub.trim();
  if (model.providerRoute === "opencode" && model.openCodeProviderId) {
    // Rows shown inside the OpenCode rail; "via OpenCode" was redundant.
    const id = model.openCodeProviderId;
    return id.charAt(0).toUpperCase() + id.slice(1);
  }
  return null;
}

export type InlineReasoningChipState = {
  visible: boolean;
  effort: string | null;
  tiers: readonly string[];
  onCycle: () => void;
};

export type ModelListRowProps = {
  model: ModelDescriptor;
  isFavorite: boolean;
  isActive: boolean;
  isAvailable: boolean;
  onSelect: (modelId: string) => void;
  onToggleFavorite: (modelId: string) => void;
  onCopyId?: (modelId: string) => void;
  onSetSurfaceDefault?: (modelId: string) => void;
  onViewDocs?: (modelId: string) => void;
  onSignIn?: () => void;
  inlineReasoningChip?: InlineReasoningChipState;
};

const REASONING_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function reasoningChipLabel(effort: string | null): string {
  if (!effort) return "Off";
  return REASONING_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

export const ModelListRow = memo(function ModelListRow({
  model,
  isFavorite,
  isActive,
  isAvailable,
  onSelect,
  onToggleFavorite,
  onCopyId,
  onSetSurfaceDefault,
  onViewDocs,
  onSignIn,
  inlineReasoningChip,
}: ModelListRowProps) {
  const sub = subProviderLabel(model);
  const localBadge = isLocalModel(model);
  const cursorBadge = cursorAvailabilityBadge(model);

  const handleSelect = useCallback(() => {
    if (!isAvailable) {
      onSignIn?.();
      return;
    }
    onSelect(model.id);
  }, [isAvailable, model.id, onSelect, onSignIn]);

  const handleToggleFavorite = useCallback(
    (event: React.MouseEvent | React.KeyboardEvent) => {
      event.stopPropagation();
      onToggleFavorite(model.id);
    },
    [model.id, onToggleFavorite],
  );

  const handleFavoriteKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        onToggleFavorite(model.id);
      }
    },
    [model.id, onToggleFavorite],
  );

  const handleSignInClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onSignIn?.();
    },
    [onSignIn],
  );

  const handleSignInKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        onSignIn?.();
      }
    },
    [onSignIn],
  );

  const reasoningCycleCb = inlineReasoningChip?.onCycle;
  const handleReasoningChipClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      reasoningCycleCb?.();
    },
    [reasoningCycleCb],
  );

  const handleReasoningChipKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        reasoningCycleCb?.();
      }
    },
    [reasoningCycleCb],
  );

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        // Only react when the event originated on the row itself, not a child
        // (the favorite-star button has its own handler).
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        handleSelect();
      }
    },
    [handleSelect],
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          role="option"
          tabIndex={-1}
          aria-selected={isActive}
          aria-disabled={!isAvailable || undefined}
          data-model-id={model.id}
          data-active={isActive ? "true" : undefined}
          onClick={handleSelect}
          onKeyDown={handleRowKeyDown}
          className={cn(
            "group flex w-full cursor-pointer items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100",
            "outline-none focus-visible:bg-white/[0.05]",
            isActive
              ? "bg-violet-500/[0.10] text-fg"
              : "text-fg/85 hover:bg-white/[0.04]",
            !isAvailable && "opacity-55",
          )}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={isFavorite ? "Unfavorite" : "Favorite"}
            aria-pressed={isFavorite}
            onClick={handleToggleFavorite}
            onKeyDown={handleFavoriteKeyDown}
            className={cn(
              "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded transition-all duration-150",
              "opacity-40 group-hover:opacity-100",
              isFavorite && "opacity-100",
              "hover:scale-110 active:scale-95",
            )}
          >
            <Star
              size={12}
              weight={isFavorite ? "fill" : "regular"}
              className={cn(
                "transition-colors duration-150",
                isFavorite ? "text-amber-400" : "text-muted-fg/70",
              )}
            />
          </button>

          <ModelRowLogo
            modelFamily={model.family}
            cliCommand={model.cliCommand}
            modelId={model.id}
            providerModelId={model.providerModelId}
            {...(model.openCodeProviderId ? { openCodeProviderId: model.openCodeProviderId } : {})}
            size={13}
            className="mt-0.5 shrink-0"
          />

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="truncate text-[12px] font-medium leading-snug">
                {model.displayName}
              </span>
              {localBadge ? (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-emerald-500/[0.12] px-1 py-px text-[9px] font-semibold uppercase leading-none text-emerald-300/85"
                  title="Offline-ready"
                >
                  <Lightning size={8} weight="fill" />
                  <span>Local</span>
                </span>
              ) : null}
              {cursorBadge ? (
                <span
                  className="inline-flex shrink-0 items-center rounded-sm bg-sky-500/[0.10] px-1 py-px text-[9px] font-semibold uppercase leading-none text-sky-200/80"
                  title={cursorBadge === "CLI only" ? "Available for Cursor CLI sessions" : "Available for Cursor chat sessions"}
                >
                  {cursorBadge}
                </span>
              ) : null}
            </span>
            {sub ? (
              <span className="block truncate text-[10px] font-normal leading-snug text-muted-fg/55">
                {sub}
              </span>
            ) : null}
            {inlineReasoningChip?.visible ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Reasoning effort: ${reasoningChipLabel(inlineReasoningChip.effort)}. Click to cycle.`}
                onClick={handleReasoningChipClick}
                onKeyDown={handleReasoningChipKeyDown}
                className={cn(
                  "mt-1 inline-flex h-4 min-h-[16px] items-center gap-1 rounded-full border border-violet-400/25 bg-violet-500/[0.08] px-1.5 py-0 text-[9px] font-semibold uppercase leading-none tracking-wide text-violet-200/90",
                  "transition-colors hover:border-violet-400/45 hover:bg-violet-500/[0.14] hover:text-violet-100",
                )}
                title="Click to cycle reasoning effort"
              >
                <span className="h-1 w-1 rounded-full bg-violet-300/80" aria-hidden />
                <span>{reasoningChipLabel(inlineReasoningChip.effort)}</span>
              </button>
            ) : null}
          </span>

          {!isAvailable && onSignIn ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={handleSignInClick}
              onKeyDown={handleSignInKeyDown}
              className="ml-1 shrink-0 self-center rounded border border-amber-400/30 bg-amber-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200/85 hover:bg-amber-400/[0.14]"
            >
              Sign in
            </button>
          ) : null}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={cn(
            "z-[110] min-w-[10rem] overflow-hidden rounded-md border border-white/[0.08] bg-[#13111A] p-1",
            "shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
          )}
        >
          <ContextMenuItem
            onSelect={() => onCopyId?.(model.id)}
            disabled={!onCopyId}
            label="Copy model id"
          />
          <ContextMenuItem
            onSelect={() => onSetSurfaceDefault?.(model.id)}
            disabled={!onSetSurfaceDefault}
            label="Set as default for this surface"
          />
          <ContextMenuItem
            onSelect={() => onViewDocs?.(model.id)}
            disabled={!onViewDocs}
            label="View model docs"
          />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

function ContextMenuItem({
  onSelect,
  disabled,
  label,
}: {
  onSelect: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "flex h-7 cursor-pointer select-none items-center rounded px-2 text-[11px] outline-none",
        "text-fg/85 data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-fg",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
      )}
    >
      {label}
    </ContextMenu.Item>
  );
}
