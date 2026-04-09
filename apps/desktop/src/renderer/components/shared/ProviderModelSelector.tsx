import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { resolveModelDescriptor, type ModelDescriptor } from "../../../shared/modelRegistry";
import { fadeScale } from "../../lib/motion";
import { cn } from "../ui/cn";
import { CaretDown, X } from "@phosphor-icons/react";
import { ModelRowLogo } from "./ProviderLogos";
import { createUnknownModelPlaceholder, ModelCatalogPanel } from "./ModelCatalogPanel";

type ProviderModelSelectorProps = {
  value: string;
  onChange: (modelId: string) => void;
  filter?: (model: ModelDescriptor) => boolean;
  availableModelIds?: string[];
  catalogMode?: "all" | "available-only";
  className?: string;
  disabled?: boolean;
  showReasoning?: boolean;
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string | null) => void;
  /** Opens AI / provider settings (e.g. navigate to `/settings?tab=ai#ai-providers`). */
  onOpenAiSettings?: () => void;
  /** @deprecated Use `onOpenAiSettings` */
  onConfigureMore?: () => void;
};

const selectCls = cn(
  "h-7 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 font-sans text-[10px] text-fg/70",
  "outline-none transition-colors duration-150 focus:border-violet-400/30",
);

function tierLabel(tier: string): string {
  if (tier === "xhigh") return "Extra High";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function ProviderModelSelector({
  value,
  onChange,
  filter,
  availableModelIds,
  catalogMode = "all",
  className,
  disabled = false,
  showReasoning,
  reasoningEffort,
  onReasoningEffortChange,
  onOpenAiSettings,
  onConfigureMore,
}: ProviderModelSelectorProps) {
  const openSettings = onOpenAiSettings ?? onConfigureMore;

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedModel = useMemo(
    () => (value ? resolveModelDescriptor(value) ?? createUnknownModelPlaceholder(value) : undefined),
    [value],
  );
  const reasoningTiers = selectedModel?.reasoningTiers ?? [];

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      const panels = document.querySelectorAll("[data-model-picker-panel='true']");
      for (const el of panels) {
        if (el.contains(target)) return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open]);

  const panel = createPortal(
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="model-picker-backdrop"
            className="fixed inset-0 z-[79] bg-black/60 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div className="pointer-events-none fixed inset-0 z-[80] flex items-start justify-center pt-[12vh]">
            <motion.div
              key="model-picker-panel"
              data-model-picker-panel="true"
              className="pointer-events-auto w-full max-w-[720px] px-3"
              variants={fadeScale}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <ModelCatalogPanel
                enabled={open}
                value={value}
                availableModelIds={availableModelIds}
                catalogMode={catalogMode}
                filter={filter}
                onOpenAiSettings={
                  openSettings
                    ? () => {
                        setOpen(false);
                        openSettings();
                      }
                    : undefined
                }
                onSelectModel={(modelId) => {
                  onChange(modelId);
                  setOpen(false);
                }}
                listboxId="model-selector-listbox"
                autoFocusSearch
                headerTrailing={(
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-muted-fg/45 transition-all duration-150 hover:border-white/[0.10] hover:bg-white/[0.05] hover:text-fg/70"
                    onClick={() => setOpen(false)}
                    aria-label="Close model picker"
                  >
                    <X size={13} weight="bold" />
                  </button>
                )}
                className="max-h-[min(520px,70vh)]"
              />
            </motion.div>
          </div>
        </>
      ) : null}
    </AnimatePresence>,
    document.body,
  );

  return (
    <div className={cn("flex max-w-full flex-wrap items-center gap-1.5", className)}>
      <div ref={containerRef} className="relative min-w-0">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setOpen((current) => !current);
          }}
          className={cn(
            "inline-flex h-7 w-auto min-w-[150px] max-w-[14rem] flex-none items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 font-sans text-[10px] text-fg/70",
            "transition-all duration-150 hover:border-violet-400/15 hover:bg-violet-500/[0.04]",
            open && "border-violet-400/20 bg-violet-500/[0.06] shadow-[0_0_12px_rgba(167,139,250,0.08)]",
            disabled && "cursor-not-allowed opacity-70 hover:border-white/[0.06] hover:bg-white/[0.03]",
          )}
          aria-label="Select model"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {selectedModel ? (
            <ModelRowLogo
              modelFamily={selectedModel.family}
              cliCommand={selectedModel.cliCommand}
              modelId={selectedModel.id}
              providerModelId={selectedModel.providerModelId}
              size={12}
            />
          ) : null}
          <span className={cn("min-w-0 flex-1 truncate text-left text-[10px] font-medium", !selectedModel && !value && "text-muted-fg/40")}>
            {selectedModel?.displayName ?? (value || "Select model")}
          </span>
          <CaretDown
            size={9}
            weight="bold"
            className={cn("flex-shrink-0 text-muted-fg/40 transition-transform duration-150", open && "rotate-180")}
          />
        </button>
      </div>

      {panel}

      {showReasoning && reasoningTiers.length > 0 && onReasoningEffortChange ? (
        <select
          value={reasoningEffort ?? ""}
          disabled={disabled}
          onChange={(event) => onReasoningEffortChange(event.target.value || null)}
          className={cn(selectCls, "min-w-[92px]", disabled && "cursor-not-allowed opacity-70")}
          aria-label="Reasoning effort"
        >
          {reasoningTiers.map((tier) => (
            <option key={tier} value={tier}>
              {tierLabel(tier)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
