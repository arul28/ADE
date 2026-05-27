import * as React from "react";
import type { Icon } from "@phosphor-icons/react";
import { motion, type Transition } from "motion/react";
import { cn } from "./cn";

export type GlowMenuItem<T extends string = string> = {
  id: T;
  label: string;
  icon: Icon;
  gradient: string;
  color: string;
};

type GlowMenuProps<T extends string> = {
  className?: string;
  items: ReadonlyArray<GlowMenuItem<T>>;
  activeItem: T;
  onItemClick: (id: T) => void;
  compact?: boolean;
  variant?: "pill" | "flat";
};

const itemVariants = {
  initial: { rotateX: 0, opacity: 1 },
  hover: { rotateX: -90, opacity: 0 },
};

const backVariants = {
  initial: { rotateX: 90, opacity: 0 },
  hover: { rotateX: 0, opacity: 1 },
};

const glowVariants = {
  initial: { opacity: 0, scale: 0.8 },
  hover: {
    opacity: 1,
    scale: 2,
    transition: {
      opacity: { duration: 0.5, ease: [0.4, 0, 0.2, 1] as const },
      scale: { duration: 0.5, type: "spring" as const, stiffness: 300, damping: 25 },
    },
  },
};

const navGlowVariants = {
  initial: { opacity: 0 },
  hover: {
    opacity: 1,
    transition: {
      duration: 0.5,
      ease: [0.4, 0, 0.2, 1] as const,
    },
  },
};

const sharedTransition: Transition = {
  type: "spring",
  stiffness: 100,
  damping: 20,
  duration: 0.5,
};

function GlowMenuItemFace<T extends string>({
  item,
  active,
  compact,
}: {
  item: GlowMenuItem<T>;
  active: boolean;
  compact: boolean;
}) {
  const Icon = item.icon;
  return (
    <>
      <span
        className="transition-colors duration-300"
        style={{ color: active ? item.color : undefined }}
      >
        <Icon size={12} weight={active ? "fill" : "regular"} className="shrink-0" />
      </span>
      <span className={compact ? "sr-only" : "truncate"}>{item.label}</span>
    </>
  );
}

export function GlowMenu<T extends string>({
  className,
  items,
  activeItem,
  onItemClick,
  compact = false,
  variant = "pill",
}: GlowMenuProps<T>) {
  const flat = variant === "flat";
  return (
    <motion.nav
      className={cn(
        flat
          ? "relative min-w-0 flex-1 overflow-hidden"
          : "relative min-w-0 overflow-hidden rounded-xl border border-white/[0.08] bg-gradient-to-b from-surface/80 to-bg/40 p-1 shadow-lg backdrop-blur-lg",
        className,
      )}
      initial="initial"
      whileHover={flat ? undefined : "hover"}
    >
      {!flat ? (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-2 z-0 rounded-2xl"
          style={{
            background:
              "radial-gradient(circle at center, rgba(96,165,250,0.14) 0%, rgba(168,85,247,0.12) 32%, rgba(248,113,113,0.08) 64%, transparent 92%)",
          }}
          variants={navGlowVariants}
        />
      ) : null}
      <ul className={cn(
        "relative z-10 flex min-w-0 items-center",
        flat ? "h-full gap-0" : "gap-1",
      )}>
        {items.map((item) => {
          const active = item.id === activeItem;
          return (
            <motion.li key={item.id} className={cn("relative min-w-0 shrink-0", flat && "h-full")}>
              <button
                type="button"
                onClick={() => onItemClick(item.id)}
                className={cn("block w-full min-w-0", flat && "h-full")}
                aria-pressed={active}
                aria-label={item.label}
                title={item.label}
              >
                <motion.div
                  className={cn(
                    "group relative block overflow-visible",
                    flat ? "h-full" : "rounded-lg",
                  )}
                  style={{ perspective: flat ? undefined : "600px" }}
                  whileHover={flat ? undefined : "hover"}
                  initial="initial"
                >
                  <motion.div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 z-0"
                    variants={glowVariants}
                    animate={active ? "hover" : "initial"}
                    style={{
                      background: item.gradient,
                      opacity: active ? 1 : 0,
                      borderRadius: flat ? 0 : 10,
                    }}
                  />
                  <motion.div
                    className={cn(
                      "relative z-10 flex items-center bg-transparent text-[10px] font-medium transition-colors",
                      flat
                        ? cn("h-full min-h-[42px] rounded-none", compact ? "justify-center px-2.5" : "gap-1.5 px-2.5")
                        : cn("rounded-lg", compact ? "justify-center px-2 py-1.5" : "gap-1.5 px-2 py-1.5"),
                      active ? "text-fg" : "text-muted-fg group-hover:text-fg",
                    )}
                    variants={flat ? undefined : itemVariants}
                    transition={sharedTransition}
                    style={flat ? undefined : {
                      transformStyle: "preserve-3d",
                      transformOrigin: "center bottom",
                    }}
                  >
                    <GlowMenuItemFace item={item} active={active} compact={compact} />
                  </motion.div>
                  {!flat ? (
                    <motion.div
                      className={cn(
                        "absolute inset-0 z-10 flex items-center bg-transparent text-[10px] font-medium transition-colors",
                        compact ? "justify-center px-2 py-1.5" : "gap-1.5 px-2 py-1.5",
                        active ? "text-fg" : "text-muted-fg group-hover:text-fg",
                        "rounded-lg",
                      )}
                      variants={backVariants}
                      transition={sharedTransition}
                      style={{
                        transformStyle: "preserve-3d",
                        transformOrigin: "center top",
                        rotateX: 90,
                      }}
                    >
                      <GlowMenuItemFace item={item} active={active} compact={compact} />
                    </motion.div>
                  ) : null}
                </motion.div>
              </button>
            </motion.li>
          );
        })}
      </ul>
    </motion.nav>
  );
}
