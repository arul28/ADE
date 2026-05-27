import { forwardRef, memo, useCallback, useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown, Lightning } from "@phosphor-icons/react";
import {
  modelSupportsFastMode,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../../shared/modelRegistry";
import { ModelRowLogo } from "../ProviderLogos";
import { cn } from "../../ui/cn";
import { ModelPickerContent } from "./ModelPickerContent";
import type { AuthStatus } from "./ModelPickerRail";
import {
  createUnknownModelPlaceholder,
  descriptorsFromAgentChatModelCatalog,
  mergeSelectorModels,
  resolveModelDescriptorWithRuntimeCatalog,
} from "./modelCatalog";
import { useModelRecents } from "./useModelRecents";
import type { AgentChatModelCatalog, AgentChatModelCatalogRefreshProvider } from "../../../../shared/types";
import {
  clearRuntimeCatalogRequest,
  getRuntimeCatalogRequest,
  getSharedRuntimeCatalog,
  rememberRuntimeCatalog,
  runtimeCatalogProviderIsFresh,
  setRuntimeCatalogRequest,
} from "./runtimeCatalogCache";

export type ModelPickerProps = {
  value: string;
  onChange: (modelId: string) => void;
  surfaceKey: string;
  compact?: boolean;
  disabled?: boolean;
  availableModelIds?: string[];
  catalogMode?: "all" | "available-only";
  filter?: (model: ModelDescriptor) => boolean;
  models?: readonly ModelDescriptor[];
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  onOpenSignIn?: () => void;
  onRuntimeCatalogRefreshed?: (provider: AgentChatModelCatalogRefreshProvider) => void;
  constrainToAvailableModelIds?: boolean;
  fastModeActive?: boolean;
  onFastModeToggle?: (next: boolean) => void;
  fastModeSupported?: boolean;
  /**
   * When invoked from a `model_selection` pending-input slot
   * (see `goal.md` §10.9), hide permission-related rail/picker rows. The
   * orchestrator forces the permission tier server-side (§12), so the user
   * should only choose model + fast-mode + reasoning. Forwarded to
   * {@link ModelPickerContent} via the `hidePermissionRail` prop.
   */
  hidePermissionRail?: boolean;
  className?: string;
  triggerClassName?: string;
};

export const ModelPicker = memo(function ModelPicker({
  value,
  onChange,
  surfaceKey,
  compact = false,
  disabled = false,
  availableModelIds,
  catalogMode,
  filter,
  models,
  providerAuthStatus,
  onOpenSignIn,
  onRuntimeCatalogRefreshed,
  constrainToAvailableModelIds = false,
  fastModeActive = false,
  onFastModeToggle,
  fastModeSupported,
  hidePermissionRail = false,
  className,
  triggerClassName,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [runtimeCatalog, setRuntimeCatalog] = useState<AgentChatModelCatalog | null>(() => getSharedRuntimeCatalog());
  const [refreshingProvider, setRefreshingProvider] = useState<AgentChatModelCatalogRefreshProvider | null>(null);
  const { recents } = useModelRecents();

  const loadRuntimeCatalog = useCallback(async (args: {
    mode: "cached" | "refresh-stale" | "force";
    refreshProvider?: AgentChatModelCatalogRefreshProvider;
  }): Promise<AgentChatModelCatalog | null> => {
    const shared = getSharedRuntimeCatalog();
    if (args.mode === "cached" && shared) {
      setRuntimeCatalog(shared);
      return shared;
    }
    if (args.mode === "refresh-stale" && args.refreshProvider && shared) {
      setRuntimeCatalog(shared);
      if (runtimeCatalogProviderIsFresh(args.refreshProvider)) {
        return { ...shared, stale: false };
      }
    }

    const bridge = window.ade?.agentChat?.modelCatalog;
    if (typeof bridge !== "function") return null;
    const requestKey = `${args.mode}:${args.refreshProvider ?? "all"}`;
    const existingRequest = getRuntimeCatalogRequest(requestKey);
    if (existingRequest) {
      const next = await existingRequest;
      if (next) setRuntimeCatalog(next);
      return next;
    }

    const request = (async () => {
      try {
        const next = await bridge(args);
        const visible = rememberRuntimeCatalog(next, args);
        setRuntimeCatalog(visible);
        return visible;
      } catch {
        // Keep the last catalog visible; renderer fallbacks cover older runtimes.
        return null;
      }
    })();
    setRuntimeCatalogRequest(requestKey, request);
    void request.finally(() => {
      clearRuntimeCatalogRequest(requestKey, request);
    });
    return await request;
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadRuntimeCatalog({ mode: "cached" });
  }, [loadRuntimeCatalog, open]);

  const handleProviderRailSelect = useCallback((family: ProviderFamily) => {
    const refreshProvider: AgentChatModelCatalogRefreshProvider | null =
      family === "opencode"
        ? "opencode"
        : family === "ollama"
          ? "ollama"
          : family === "lmstudio"
            ? "lmstudio"
            : family === "cursor"
              ? "cursor"
              : family === "factory"
                ? "droid"
                : null;
    if (refreshProvider) {
      void (async () => {
        const shared = getSharedRuntimeCatalog();
        if (shared) {
          setRuntimeCatalog(shared);
          if (runtimeCatalogProviderIsFresh(refreshProvider)) return;
        }
        setRefreshingProvider(refreshProvider);
        try {
          const immediate = await loadRuntimeCatalog({ mode: "refresh-stale", refreshProvider });
          if (immediate?.stale === true) {
            await loadRuntimeCatalog({ mode: "force", refreshProvider });
          }
        } finally {
          setRefreshingProvider((current) => current === refreshProvider ? null : current);
          onRuntimeCatalogRefreshed?.(refreshProvider);
        }
      })();
    }
  }, [loadRuntimeCatalog, onRuntimeCatalogRefreshed]);

  const catalogModels = useMemo(
    () => descriptorsFromAgentChatModelCatalog(runtimeCatalog, filter),
    [filter, runtimeCatalog],
  );

  const modelList = useMemo<readonly ModelDescriptor[]>(() => {
    const constrainedAvailable = constrainToAvailableModelIds
      ? new Set((availableModelIds ?? []).map((id) => id.trim()).filter(Boolean))
      : null;
    if (models && models.length) {
      if (!constrainedAvailable) return models;
      const constrainedModels = models.filter((model) => constrainedAvailable.has(model.id.trim()));
      if (constrainedModels.length > 0) return constrainedModels;
    }
    const selectedValue = (() => {
      if (!constrainedAvailable) return value;
      const normalizedValue = value.trim();
      if (!normalizedValue) return "";
      return constrainedAvailable.has(normalizedValue) ? normalizedValue : "";
    })();
    const fallbackModels = mergeSelectorModels(
      availableModelIds,
      selectedValue,
      filter,
      constrainToAvailableModelIds ? "available-only" : catalogMode,
    );
    if (catalogModels.models.length === 0) return fallbackModels;
    if (constrainToAvailableModelIds) return fallbackModels;
    const merged = new Map<string, ModelDescriptor>();
    for (const model of fallbackModels) merged.set(model.id, model);
    for (const model of catalogModels.models) merged.set(model.id, model);
    return [...merged.values()];
  }, [models, availableModelIds, value, filter, catalogMode, catalogModels.models, constrainToAvailableModelIds]);

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
    if (!value) return undefined;
    return resolveModelDescriptorWithRuntimeCatalog(value) ?? createUnknownModelPlaceholder(value);
  }, [value]);

  const availableSet = useMemo(() => {
    const ids = constrainToAvailableModelIds || !runtimeCatalog
      ? availableModelIds
      : catalogModels.availableModelIds;
    if (!ids) return null;
    return new Set(ids.map((id) => id.trim()).filter(Boolean));
  }, [availableModelIds, catalogModels.availableModelIds, constrainToAvailableModelIds, runtimeCatalog]);

  const isAvailable = useCallback(
    (modelId: string): boolean => {
      if (!availableSet) return true;
      return availableSet.has(modelId);
    },
    [availableSet],
  );

  const handleSelect = useCallback(
    (modelId: string) => {
      onChange(modelId);
      setOpen(false);
    },
    [onChange],
  );

  const handleRequestClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleOpenSignIn = useCallback(() => {
    setOpen(false);
    onOpenSignIn?.();
  }, [onOpenSignIn]);

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
          const shared = getSharedRuntimeCatalog();
          if (next && shared) {
            setRuntimeCatalog(shared);
          }
          setOpen(next);
        }}
      >
        <Popover.Trigger asChild>
          <ModelPickerTrigger
            model={selectedModel}
            value={value}
            compact={compact}
            disabled={disabled}
            open={open}
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
                onProviderRailSelect={handleProviderRailSelect}
                refreshingProvider={refreshingProvider}
                hidePermissionRail={hidePermissionRail}
                allowRegistryExpansion={!constrainToAvailableModelIds}
                {...(onOpenSignIn ? { onOpenSignIn: handleOpenSignIn } : {})}
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
  className?: string;
};

const ModelPickerTrigger = memo(
  forwardRef<HTMLButtonElement, TriggerProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
    function ModelPickerTrigger(
      { model, value, compact, disabled, open, className, ...rest },
      ref,
    ) {
      const label = model?.displayName ?? (value.trim() || "Select model");
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
              ? "h-6 px-1 text-[9px]"
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
        "inline-flex shrink-0 items-center justify-center rounded-md border font-sans font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        compact
          ? "ade-chat-composer-fast-toggle h-6 gap-0.5 px-1.5 text-[9px]"
          : "h-8 gap-1 px-2 text-[11px]",
        active
          ? "border-amber-300/30 bg-amber-400/12 text-amber-100 shadow-[0_0_0_1px_rgba(251,191,36,0.08)]"
          : "border-white/[0.07] bg-white/[0.025] text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg/80",
      )}
    >
      <Lightning size={compact ? 10 : 13} weight="fill" />
      <span className={cn(compact ? "ade-chat-composer-fast-label" : undefined)}>Fast</span>
    </button>
  );
});
