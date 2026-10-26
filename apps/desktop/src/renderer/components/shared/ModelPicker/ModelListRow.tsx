import { memo, useCallback } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Brain, Check, ImageSquare, Lightning, Star } from "@phosphor-icons/react";
import {
  modelSupportsFastMode,
  modelSupportsServiceTier,
  modelSupportsUltrafast,
  type FastTier,
  type ModelDescriptor,
} from "../../../../shared/modelRegistry";
import type { CursorCloudServiceTier } from "../../../../shared/types/config";
import { ModelRowLogo } from "../ProviderLogos";
import {
  capitalizeWord,
  formatTokenCount,
  isLocalModel,
  modelDetailLine,
  subProviderLabel,
} from "./modelFacts";
import { cn } from "../../ui/cn";
import { Z_LAYERS } from "../../ui/zLayers";
import { usePrefersReducedMotion } from "../../../hooks/usePrefersReducedMotion";

/**
 * The row's amber, one ramp. Two pills in this file warn — the sign-in prompt
 * and a Fast tier the server declined — and they used to carry two different
 * alpha ladders for the same meaning.
 */
const MODEL_ROW_WARN_TONE = "border-amber-400/40 bg-amber-400/[0.10] text-amber-200/90";

/**
 * A reported service tier, spelled the way a person reads it. The server
 * answers with a bare lowercase word — `fast`, `ultrafast`, and also `default`
 * or `priority` when it inherits the user's own config — and ADE does not
 * enumerate the set, so an unfamiliar word keeps its own spelling rather than
 * being dropped.
 */
function fastTierLabel(tier: string | null | undefined): string | null {
  const trimmed = tier?.trim();
  return trimmed ? capitalizeWord(trimmed) : null;
}

export type ModelListRowProps = {
  model: ModelDescriptor;
  isFavorite: boolean;
  isActive: boolean;
  isFocused?: boolean;
  isAvailable: boolean;
  onSelect: (modelId: string) => void;
  onToggleFavorite: (modelId: string) => void;
  onFocus?: () => void;
  onCopyId?: (modelId: string) => void;
  onViewDocs?: (modelId: string) => void;
  onSignIn?: () => void;
  /**
   * Whether *this row's* chip reads as on. Fast mode is one bit on the surface,
   * but it only applies to the model it was enabled for — the parent derives
   * this as `fastMode && isActive` so a toggle never lights every fast-capable
   * row at once.
   */
  fastModeOn?: boolean;
  /**
   * Absent when the surface has not opted into fast mode — no chip is drawn.
   * Takes the model id because the handler's behaviour differs for the selected
   * row (plain toggle) and a non-selected one (select + enable).
   */
  onFastModeChange?: (modelId: string, next: boolean, tier?: FastTier) => void;
  /** The faster tier this row's Fast is on, when it is on. Absent is plain Fast. */
  fastTier?: FastTier | null;
  /** The surface carries Fast's tier, so a model that offers Ultrafast cycles to it. */
  ultrafastEnabled?: boolean;
  /**
   * The tier the server last reported for this chat's Fast, when it has
   * reported one. Fast is a *request*: Codex can answer `thread/start` with a
   * different tier than ADE asked for, and until ADE says so the picker claims
   * a tier the chat is not running. Only the chat's own row carries this —
   * the report belongs to the session, not to every model in the list.
   */
  effectiveFastTier?: string | null;
  /**
   * Why Fast cannot run with this row's other picks (an OpenCode effort with
   * no Fast route). The chip dims, shows the reason, and cannot turn Fast on.
   * It can still turn Fast off.
   */
  fastUnavailableReason?: string | null;
  /** Cursor Cloud's nullable fast/standard service-tier affordance. */
  serviceTierMode?: boolean;
  serviceTier?: CursorCloudServiceTier | null;
  onServiceTierChange?: (modelId: string, next: CursorCloudServiceTier | null) => void;
  copilotContextTier?: "default" | "long_context";
  onCopilotContextTierChange?: (modelId: string, next: "default" | "long_context") => void;
  /** The list is scoped to this row's provider, so the detail line need not name it. */
  omitProviderInDetail?: boolean;
};

export const ModelListRow = memo(function ModelListRow({
  model,
  isFavorite,
  isActive,
  isFocused = false,
  isAvailable,
  onSelect,
  onToggleFavorite,
  onFocus,
  onCopyId,
  onViewDocs,
  onSignIn,
  fastModeOn = false,
  onFastModeChange,
  fastTier = null,
  effectiveFastTier = null,
  ultrafastEnabled = false,
  fastUnavailableReason = null,
  serviceTierMode = false,
  serviceTier = null,
  onServiceTierChange,
  copilotContextTier = "default",
  onCopilotContextTierChange,
  omitProviderInDetail = false,
}: ModelListRowProps) {
  const sub = subProviderLabel(model);
  const showCopilotContextChip = Boolean(onCopilotContextTierChange)
    && model.family === "github-copilot"
    && model.supportedContextTiers?.includes("long_context") === true;
  const details = modelDetailLine(model, { omitProvider: omitProviderInDetail, omitContext: showCopilotContextChip });
  const localBadge = isLocalModel(model);
  const maxModeBadge = model.cursorMaxModeOnly === true;
  const showFastChip = !serviceTierMode && Boolean(onFastModeChange) && modelSupportsFastMode(model);
  const fastBlocked = showFastChip && Boolean(fastUnavailableReason);
  const showServiceTierChip = serviceTierMode
    && Boolean(onServiceTierChange)
    && (modelSupportsServiceTier(model, "fast") || modelSupportsServiceTier(model, "standard"));
  const showAnyModeChip = showFastChip || showServiceTierChip || showCopilotContextChip;
  // A model whose catalog offers Ultrafast cycles Off → Fast → Ultrafast → Off.
  const offersUltrafast = ultrafastEnabled && showFastChip && modelSupportsUltrafast(model);
  const ultrafastOn = offersUltrafast && fastModeOn && fastTier === "ultrafast";
  const activeTier = serviceTierMode ? serviceTier : (fastModeOn ? "fast" : null);
  // Fast is what ADE *asked* for; `effectiveFastTier` is what the server
  // reported. When they disagree the chip used to keep claiming the request,
  // so a tier the server declined or downgraded was invisible. The badge says
  // what the chat is really running, and is marked when that is not the ask.
  const requestedFastTier = showFastChip && fastModeOn ? (ultrafastOn ? "ultrafast" : "fast") : null;
  const effectiveFastLabel = fastTierLabel(effectiveFastTier);
  const fastTierDeclined = Boolean(
    effectiveFastLabel
    && requestedFastTier
    && effectiveFastLabel.toLowerCase() !== requestedFastTier,
  );
  // One owner for "does this row draw the badge", so the render and the row's
  // aria-label can never disagree about it.
  const showBadge = Boolean(isActive && requestedFastTier && effectiveFastLabel);
  const reducedMotion = usePrefersReducedMotion();
  const thinks = Boolean(model.capabilities?.reasoning) || (model.reasoningTiers?.length ?? 0) > 0;
  const seesImages = Boolean(model.capabilities?.vision);
  // The surface offers a speed control, so every row reserves its slot: the
  // capability column then lines up whether or not this model has the chip.
  const reservesSpeedSlot = serviceTierMode ? Boolean(onServiceTierChange) : Boolean(onFastModeChange);

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

  // The chip never falls through to the row's own click handler; whether the
  // press also commits a model selection is the parent's call (see
  // `ModelPickerContent`), because only it knows which row is selected.
  const cycleFast = useCallback(() => {
    if (!fastModeOn) {
      onFastModeChange?.(model.id, true, "fast");
    } else if (offersUltrafast && !ultrafastOn) {
      onFastModeChange?.(model.id, true, "ultrafast");
    } else {
      onFastModeChange?.(model.id, false);
    }
  }, [fastModeOn, model.id, offersUltrafast, onFastModeChange, ultrafastOn]);

  const handleFastChipClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      cycleFast();
    },
    [cycleFast],
  );

  const handleFastChipKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        cycleFast();
      }
    },
    [cycleFast],
  );

  const handleServiceTierClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      const supported = [
        ...(modelSupportsServiceTier(model, "fast") ? ["fast" as const] : []),
        ...(modelSupportsServiceTier(model, "standard") ? ["standard" as const] : []),
      ];
      const currentIndex = activeTier ? supported.indexOf(activeTier) : -1;
      const next = currentIndex < 0
        ? (supported[0] ?? null)
        : currentIndex + 1 < supported.length
          ? supported[currentIndex + 1] ?? null
          : null;
      onServiceTierChange?.(model.id, next);
    },
    [activeTier, model, onServiceTierChange],
  );

  const handleServiceTierKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        handleServiceTierClick(event as unknown as React.MouseEvent);
      }
    },
    [handleServiceTierClick],
  );

  const handleCopilotContextTierClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    onCopilotContextTierChange?.(model.id, copilotContextTier === "long_context" ? "default" : "long_context");
  }, [copilotContextTier, model.id, onCopilotContextTierChange]);

  const handleCopilotContextTierKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onCopilotContextTierChange?.(model.id, copilotContextTier === "long_context" ? "default" : "long_context");
  }, [copilotContextTier, model.id, onCopilotContextTierChange]);

  const defaultContextLabel = formatTokenCount(model.contextWindow) ?? "Default";
  const longContextLabel = formatTokenCount(model.longContextWindow) ?? "Long";

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
          tabIndex={isFocused ? 0 : -1}
          id={`model-picker-row-${encodeURIComponent(model.id)}`}
          aria-disabled={!isAvailable || undefined}
          aria-selected={isActive}
          aria-current={isFocused ? "true" : undefined}
          aria-label={`${model.displayName}${sub ? `, ${sub}` : ""}${maxModeBadge ? ", max mode only" : ""}${isActive ? ", selected" : ""}${!isAvailable ? ", unavailable" : ""}${
            // This label replaces the descendants' accessible names, so the
            // badge beside the chip is otherwise invisible to a screen reader —
            // and "the server gave you a different tier" is exactly the kind of
            // state a colour and a mouse-only title must not be the only carrier
            // of.
            showBadge ? `, running ${effectiveFastLabel}${fastTierDeclined ? ` instead of the ${fastTierLabel(requestedFastTier)} this chat asked for` : ""}` : ""
          }`}
          data-model-id={model.id}
          data-active={isActive ? "true" : undefined}
          onFocus={onFocus}
          onClick={handleSelect}
          onKeyDown={handleRowKeyDown}
          className={cn(
            // Fixed height: the picker's virtual list sizes rows from
            // MODEL_ROW_HEIGHT instead of measuring each one as it opens.
            "group flex h-12 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150",
            "outline-none focus-visible:bg-fg/[0.05]",
            isActive
              ? "bg-fg/[0.065] text-fg"
              : "text-fg/85 hover:bg-fg/[0.04] hover:text-fg",
            !isAvailable && "opacity-55",
          )}
        >
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
            <ModelRowLogo
              modelFamily={model.family}
              cliCommand={model.cliCommand}
              modelId={model.id}
              providerModelId={model.providerModelId}
              {...(model.openCodeProviderId ? { openCodeProviderId: model.openCodeProviderId } : {})}
              size={15}
              className="shrink-0"
            />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-medium leading-snug tracking-tight">
                {model.displayName}
              </span>
              {isActive ? (
                <Check size={12} weight="bold" className="shrink-0 text-fg/90" aria-hidden />
              ) : null}
              {localBadge ? (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-500/[0.12] px-1.5 py-px text-[9px] font-semibold uppercase leading-none text-emerald-300/85"
                  title="Offline-ready"
                >
                  <Lightning size={8} weight="fill" />
                  <span>Local</span>
                </span>
              ) : null}
              {maxModeBadge ? (
                <span
                  className="inline-flex shrink-0 items-center rounded-full bg-amber-500/[0.12] px-1.5 py-px text-[9px] font-semibold uppercase leading-none text-amber-300/85"
                  title="Only runs in Cursor's Max mode, which bills at higher rates"
                >
                  Max
                </span>
              ) : null}
            </span>
            {details ? (
              <span
                className="block truncate text-[11px] font-normal leading-snug text-muted-fg/60"
                title={details}
              >
                {details}
              </span>
            ) : null}
          </span>

          {!isAvailable && onSignIn ? (
            <button
              type="button"
              tabIndex={isFocused ? 0 : -1}
              onClick={handleSignInClick}
              onKeyDown={handleSignInKeyDown}
              className={cn(
                "shrink-0 self-center rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-wide hover:bg-amber-400/[0.16]",
                MODEL_ROW_WARN_TONE,
              )}
            >
              Sign in
            </button>
          ) : null}

          {/* Two fixed slots, so the columns line up down the list. A missing
              capability stays as a faint mark rather than a gap. */}
          <span
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5",
              thinks || seesImages ? "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" : "invisible",
            )}
            data-model-capabilities="true"
          >
            <span
              title={thinks ? "Reasoning" : "No reasoning"}
              aria-label={thinks ? "Reasoning" : undefined}
              aria-hidden={thinks ? undefined : true}
              className={cn("inline-flex", thinks ? "text-violet-400/90" : "text-fg/15")}
            >
              <Brain size={13} aria-hidden />
            </span>
            <span aria-hidden className="h-3 w-px bg-fg/[0.1]" />
            <span
              title={seesImages ? "Reads images" : "No image input"}
              aria-label={seesImages ? "Reads images" : undefined}
              aria-hidden={seesImages ? undefined : true}
              className={cn("inline-flex", seesImages ? "text-teal-400/90" : "text-fg/15")}
            >
              <ImageSquare size={13} aria-hidden />
            </span>
          </span>

          {showAnyModeChip ? (
            <button
              type="button"
              tabIndex={isFocused ? 0 : -1}
              data-model-picker-fast-toggle={showFastChip ? "true" : undefined}
              data-model-picker-service-tier={showServiceTierChip ? "true" : undefined}
              data-model-picker-context-tier={showCopilotContextChip ? "true" : undefined}
              aria-label={showCopilotContextChip
                ? `Context window for ${model.displayName}`
                : showServiceTierChip
                ? `Service tier for ${model.displayName}`
                : `Fast mode for ${model.displayName}`}
              aria-pressed={showCopilotContextChip ? copilotContextTier === "long_context" : activeTier != null}
              data-fast-on={activeTier === "fast" ? "true" : undefined}
              data-fast-tier={ultrafastOn ? "ultrafast" : undefined}
              data-fast-unavailable={fastBlocked ? "true" : undefined}
              title={
                showCopilotContextChip
                  ? `${copilotContextTier === "long_context" ? longContextLabel : defaultContextLabel} context window; long context may cost more`
                  : showServiceTierChip
                  ? activeTier
                    ? `${activeTier === "fast" ? "Fast" : "Standard"} tier selected — click to cycle`
                    : "Leave service tier unset — click to choose a tier"
                  : fastBlocked
                  ? fastUnavailableReason ?? undefined
                  : ultrafastOn
                  ? "Ultrafast on — click to turn off"
                  : fastModeOn
                  ? offersUltrafast ? "Fast on — click for Ultrafast" : "Fast mode on"
                  : isActive
                    ? "Enable fast mode"
                    : `Use ${model.displayName} in fast mode`
              }
              // Fast that cannot run must not turn on; one that is on can still turn off.
              disabled={fastBlocked && !fastModeOn}
              onClick={showCopilotContextChip ? handleCopilotContextTierClick : showServiceTierChip ? handleServiceTierClick : handleFastChipClick}
              onKeyDown={showCopilotContextChip ? handleCopilotContextTierKeyDown : showServiceTierChip ? handleServiceTierKeyDown : handleFastChipKeyDown}
              className={cn(
                "inline-flex h-6 shrink-0 items-center justify-center gap-1 self-center rounded-full border",
                showServiceTierChip ? "w-[78px]" : "w-[58px]",
                "text-[9px] font-semibold uppercase leading-none tracking-wide",
                "disabled:cursor-not-allowed",
                fastBlocked && "opacity-45",
                // Rest reads as plainly off; hover only darkens; the press itself
                // is the depress; "on" is the only violet state.
                reducedMotion ? "transition-none" : "transition-[color,background-color,border-color,transform] duration-100",
                (showCopilotContextChip ? copilotContextTier === "long_context" : Boolean(activeTier))
                  ? "border-violet-400/50 bg-violet-500/85 text-white shadow-[0_0_0_1px_rgba(139,92,246,0.20)] hover:bg-violet-500 active:bg-violet-500/70"
                  : "border-fg/[0.08] bg-fg/[0.02] text-muted-fg/55 hover:border-fg/[0.18] hover:bg-fg/[0.08] hover:text-fg/80 active:bg-fg/[0.12]",
              )}
            >
              {showCopilotContextChip ? null : <Lightning size={10} weight={activeTier === "fast" ? "fill" : "regular"} />}
              {ultrafastOn && !showCopilotContextChip ? <Lightning size={10} weight="fill" className="-ml-1.5" aria-hidden /> : null}
              <span>{showCopilotContextChip
                ? copilotContextTier === "long_context" ? longContextLabel : defaultContextLabel
                : showServiceTierChip ? (activeTier === "fast" ? "Fast" : activeTier === "standard" ? "Standard" : "Tier") : ultrafastOn ? "Ultra" : "Fast"}</span>
            </button>
          ) : reservesSpeedSlot ? (
            <span aria-hidden className={cn("shrink-0", serviceTierMode ? "w-[78px]" : "w-[58px]")} />
          ) : null}

          {/* What the server reported for this chat's Fast, next to the chip
              that asked for it. Only the chat's own row carries it: the report
              is the session's, not the model's, and reading it on every row
              would claim every model runs what this one does. */}
          {/* Only while Fast is actually on. With Fast off ADE sends no tier at
              all (`codexServiceTierArgs` omits it so the server re-resolves
              from the user's config.toml), so there is no request for the
              report to answer — and a badge saying "as asked" when nothing was
              asked is worse than no badge. */}
          {showBadge ? (
            <span
              data-model-picker-effective-tier={fastTierDeclined ? "declined" : "matched"}
              title={fastTierDeclined
                ? `The server is running ${effectiveFastLabel}, not the ${fastTierLabel(requestedFastTier)} this chat asked for.`
                : `The server is running ${effectiveFastLabel}, as asked.`}
              className={cn(
                "inline-flex h-6 shrink-0 items-center self-center rounded-full border px-1.5 text-[9px] font-semibold uppercase leading-none tracking-wide",
                fastTierDeclined ? MODEL_ROW_WARN_TONE : "border-fg/[0.08] bg-fg/[0.02] text-muted-fg/55",
              )}
            >
              {effectiveFastLabel}
            </span>
          ) : null}

          <button
            type="button"
            tabIndex={isFocused ? 0 : -1}
            aria-label={isFavorite ? "Unfavorite" : "Favorite"}
            aria-pressed={isFavorite}
            onClick={handleToggleFavorite}
            onKeyDown={handleFavoriteKeyDown}
            className={cn(
              "-mr-1 inline-flex h-6 w-5 shrink-0 items-center justify-center rounded transition-opacity duration-150",
              isFavorite ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-60 hover:!opacity-100",
            )}
          >
            <Star
              size={12}
              weight={isFavorite ? "fill" : "regular"}
              className={isFavorite ? "text-amber-400" : "text-muted-fg/80"}
            />
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          style={{ zIndex: Z_LAYERS.contextMenu }}
          className={cn(
            "min-w-[10rem] overflow-hidden rounded-md border border-fg/[0.08] bg-(color:--work-popover-bg) p-1",
            "shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
          )}
        >
          <ContextMenuItem
            onSelect={() => onCopyId?.(model.id)}
            disabled={!onCopyId}
            label="Copy model id"
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
        "text-fg/85 data-[highlighted]:bg-fg/[0.06] data-[highlighted]:text-fg",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
      )}
    >
      {label}
    </ContextMenu.Item>
  );
}
