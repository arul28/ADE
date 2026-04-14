import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

export function BottomDrawerSection({
  label,
  icon: IconComponent,
  summary,
  expanded,
  onToggle,
  children,
  className,
}: {
  label: string;
  icon: Icon;
  summary: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-t border-white/[0.06] bg-[#0D0B12]/60", className)}>
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {expanded ? (
          <CaretDown size={12} weight="bold" className="shrink-0 text-fg/35" />
        ) : (
          <CaretRight size={12} weight="bold" className="shrink-0 text-fg/35" />
        )}
        <IconComponent size={14} weight="bold" className="shrink-0 text-fg/35" />
        <span className="text-[11px] font-semibold tracking-[0.08em] text-fg/45">
          {label}
        </span>
        <div className="min-w-0 flex-1 truncate text-[12px] text-fg/50">
          {summary}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="max-h-[40vh] overflow-y-auto border-t border-white/[0.04]">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
