import { forwardRef, memo, useCallback, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown, Lightning } from "@phosphor-icons/react";
import {
  modelSupportsFastMode,
  resolveModelDescriptor,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../../shared/modelRegistry";
import { ModelRowLogo } from "../ProviderLogos";
import { cn } from "../../ui/cn";
import { ModelPickerContent } from "./ModelPickerContent";
import type { AuthStatus } from "./ModelPickerRail";
import { createUnknownModelPlaceholder, mergeSelectorModels } from "./modelCatalog";
import { useModelRecents } from "./useModelRecents";
import { useReasoningByFamily } from "./useReasoningByFamily";

export type ModelPickerProps = {
  value: string;
  onChange: (modelId: string) => void;
  surfaceKey: string;
  compact?: boolean;
  disabled?: boolean;
  showReasoning?: boolean;
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string | null) => void;
  availableModelIds?: string[];
  catalogMode?: "all" | "available-only";
  filter?: (model: ModelDescriptor) => boolean;
  models?: readonly ModelDescriptor[];
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  onOpenSignIn?: () => void;
  fastModeActive?: boolean;
  onFastModeToggle?: (next: boolean) => void;
  fastModeSupported?: boolean;
  className?: string;
  triggerClassName?: string;
};

function reasoningChipLabel(effort: string | null | undefined): string | null {
  if (!effort) return null;
  const lower = effort.trim().toLowerCase();
  if (!lower) return null;
  if (lower === "minimal") return "MIN";
  if (lower === "low") return "LOW";
  if (lower === "medium") return "MED";
  if (lower === "high") return "HI";
  if (lower === "xhigh") return "XH";
  if (lower === "max") return "MAX";
  return lower.slice(0, 3).toUpperCase();
}

export const ModelPicker = memo(function ModelPicker({
  value,
  onChange,
  surfaceKey,
  compact = false,
  disabled = false,
  showReasoning,
  reasoningEffort = null,
  onReasoningEffortChange,
  availableModelIds,
  catalogMode,
  filter,
  models,
  providerAuthStatus,
  onOpenSignIn,
  fastModeActive = false,
  onFastModeToggle,
  fastModeSupported,
  className,
  triggerClassName,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const { recents } = useModelRecents();
  const { getReasoningForFamily } = useReasoningByFamily();

  const modelList = useMemo<readonly ModelDescriptor[]>(() => {
    if (models && models.length) return models;
    return mergeSelectorModels(availableModelIds, value, filter, catalogMode);
  }, [models, availableModelIds, value, filter, catalogMode]);

  const effectiveValue = useMemo<string>(() => {
    if (value && value.length > 0) return value;
    if (recents.length > 0) {
      const fromRecents = recents.find((id) => modelList.some((m) => m.id === id));
      if (fromRecents) return fromRecents;
      return recents[0] ?? "";
    }
    const firstModel = modelList[0];
    return firstModel ? firstModel.id : "";
  }, [value, recents, modelList]);

  const selectedModel = useMemo<ModelDescriptor | undefined>(() => {
    if (!effectiveValue) return undefined;
    return resolveModelDescriptor(effectiveValue) ?? createUnknownModelPlaceholder(effectiveValue);
  }, [effectiveValue]);

  const availableSet = useMemo(() => {
    if (!availableModelIds) return null;
    return new Set(availableModelIds.map((id) => id.trim()).filter(Boolean));
  }, [availableModelIds]);

  const isAvailable = useCallback(
    (modelId: string): boolean => {
      if (!availableSet) return true;
      return availableSet.has(modelId);
    },
    [availableSet],
  );

  const handleSelect = useCallback(
    (modelId: string) => {
      // When selecting a model from a different family, restore that family's
      // remembered reasoning effort so callers don't carry stale state across providers.
      if (onReasoningEffortChange) {
        const previous = selectedModel?.family;
        const nextDescriptor = resolveModelDescriptor(modelId);
        const nextFamily = nextDescriptor?.family;
        if (nextFamily && previous && nextFamily !== previous) {
          const remembered = getReasoningForFamily(nextFamily);
          onReasoningEffortChange(remembered);
        }
      }
      onChange(modelId);
      setOpen(false);
    },
    [getReasoningForFamily, onChange, onReasoningEffortChange, selectedModel],
  );

  const handleRequestClose = useCallback(() => {
    setOpen(false);
  }, []);

  const triggerReasoning =
    showReasoning && selectedModel && (selectedModel.reasoningTiers?.length ?? 0) > 0
      ? reasoningChipLabel(
          (value && reasoningEffort) || getReasoningForFamily(selectedModel.family),
        )
      : null;

  const triggerFastSupported =
    typeof fastModeSupported === "boolean"
      ? fastModeSupported
      : modelSupportsFastMode(selectedModel);
  const showFastToggle = triggerFastSupported && typeof onFastModeToggle === "function";

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (disabled) {
            setOpen(false);
            return;
          }
          setOpen(next);
        }}
      >
        <Popover.Trigger asChild>
          <ModelPickerTrigger
            model={selectedModel}
            value={effectiveValue}
            compact={compact}
            disabled={disabled}
            open={open}
            reasoningLabel={triggerReasoning}
            className={triggerClassName}
          />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            avoidCollisions
            className="z-[100] outline-none"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
            }}
          >
            {open ? (
              <ModelPickerContent
                value={effectiveValue}
                surfaceKey={surfaceKey}
                models={modelList}
                isAvailable={isAvailable}
                {...(providerAuthStatus ? { providerAuthStatus } : {})}
                onSelect={handleSelect}
                onRequestClose={handleRequestClose}
                {...(showReasoning ? { showReasoning: true } : {})}
                reasoningEffort={reasoningEffort}
                {...(onReasoningEffortChange ? { onReasoningEffortChange } : {})}
                {...(onOpenSignIn ? { onOpenSignIn } : {})}
              />
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {showFastToggle ? (
        <FastModeButton
          active={fastModeActive}
          disabled={disabled}
          compact={compact}
          onToggle={onFastModeToggle}
        />
      ) : null}
    </div>
  );
});

type TriggerProps = {
  model: ModelDescriptor | undefined;
  value: string;
  compact: boolean;
  disabled: boolean;
  open: boolean;
  reasoningLabel: string | null;
  className?: string;
};

const ModelPickerTrigger = memo(
  forwardRef<HTMLButtonElement, TriggerProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
    function ModelPickerTrigger(
      { model, value, compact, disabled, open, reasoningLabel, className, ...rest },
      ref,
    ) {
      const label = model?.displayName ?? value ?? "Select model";
      return (
        <button
          {...rest}
          ref={ref}
          type="button"
          data-state={open ? "open" : "closed"}
          disabled={disabled}
          aria-label={`Select model (current: ${label})`}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 rounded-md border font-sans transition-colors duration-150",
            compact
              ? "h-7 px-1.5 text-[10px]"
              : "h-8 px-2 text-[11px] sm:text-[12px]",
            "border-white/[0.06] bg-white/[0.03] text-fg/80",
            "hover:border-violet-400/20 hover:bg-violet-500/[0.06] hover:text-fg",
            open && "border-violet-400/30 bg-violet-500/[0.08] text-fg",
            disabled && "cursor-not-allowed opacity-60 hover:border-white/[0.06] hover:bg-white/[0.03]",
            className,
          )}
        >
          {model ? (
            <ModelRowLogo
              modelFamily={model.family}
              cliCommand={model.cliCommand}
              modelId={model.id}
              providerModelId={model.providerModelId}
              size={compact ? 11 : 13}
              className="shrink-0"
            />
          ) : null}
          <span className="min-w-0 truncate font-medium leading-none">{label}</span>
          {reasoningLabel ? (
            <span
              data-model-picker-reasoning-chip="true"
              className={cn(
                "shrink-0 rounded border border-violet-400/25 bg-violet-500/[0.12] px-1 font-semibold uppercase leading-none tracking-wide text-violet-100/90",
                compact ? "py-[1px] text-[8px]" : "py-[2px] text-[9px]",
              )}
            >
              {reasoningLabel}
            </span>
          ) : null}
          <CaretDown
            size={compact ? 9 : 10}
            weight="bold"
            className={cn(
              "shrink-0 text-muted-fg/60 transition-transform duration-150",
              open && "rotate-180 text-fg/80",
            )}
          />
        </button>
      );
    },
  ),
);

const FastModeButton = memo(function FastModeButton({
  active,
  disabled,
  compact,
  onToggle,
}: {
  active: boolean;
  disabled: boolean;
  compact: boolean;
  onToggle?: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      data-model-picker-fast-toggle="true"
      aria-label="Fast mode"
      aria-pressed={active}
      title={active ? "Fast mode on" : "Enable fast mode"}
      disabled={disabled || !onToggle}
      onClick={() => onToggle?.(!active)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border font-sans font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        compact ? "h-7 px-1.5 text-[10px]" : "h-8 px-2 text-[11px]",
        active
          ? "border-amber-300/30 bg-amber-400/12 text-amber-100 shadow-[0_0_0_1px_rgba(251,191,36,0.08)]"
          : "border-white/[0.07] bg-white/[0.025] text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg/80",
      )}
    >
      <Lightning size={compact ? 11 : 13} weight="fill" />
      <span>Fast</span>
    </button>
  );
});
