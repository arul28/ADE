import React from "react";
import { motion } from "motion/react";
import { cn } from "./cn";

export function EmptyState({
  title,
  description,
  icon: Icon,
  className,
  children
}: {
  title: string;
  description?: string;
  icon?: React.ElementType;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn("flex flex-col items-center justify-center p-10 text-center", className)}
      style={{ background: "#13101A", border: "1px solid #1E1B26" }}
    >
      {Icon ? (
        <div className="mb-4 inline-flex items-center justify-center">
          <Icon size={48} weight="regular" className="text-[#52525B]" />
        </div>
      ) : null}
      <div
        className="text-[14px] font-bold tracking-[-0.3px] text-[#FAFAFA]"
        style={{ fontFamily: "'Space Grotesk', sans-serif" }}
      >
        {title}
      </div>
      {description ? (
        <div className="mt-2 font-mono text-[11px] text-[#71717A] max-w-[45ch] mx-auto leading-relaxed">
          {description}
        </div>
      ) : null}
      {children}
    </motion.div>
  );
}
