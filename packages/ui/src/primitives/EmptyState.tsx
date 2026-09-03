import React from "react";
import { cn } from "./cn";

/**
 * The enter transition runs through the Web Animations API rather than a
 * motion library.
 *
 * The desktop version used `motion/react` for one 300 ms fade-and-rise. A
 * plugin page should not have to bundle an animation runtime for that, and the
 * kit should not carry a second copy of one for the desktop, so the same
 * keyframes are played directly on the node. Environments without
 * `Element.animate` (jsdom, and any host that has it disabled) simply render
 * the final state, which is what a skipped animation should look like.
 */
function useEnterAnimation(): React.RefObject<HTMLDivElement> {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof node.animate !== "function") return;
    node.animate(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 300, easing: "ease-out", fill: "backwards" },
    );
  }, []);
  return ref;
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  iconSize = 48,
  className,
  children
}: {
  title: string;
  description?: string;
  icon?: React.ElementType;
  iconSize?: number;
  className?: string;
  children?: React.ReactNode;
}) {
  const ref = useEnterAnimation();
  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center p-10 text-center",
        "ade-empty-state",
        className
      )}
      style={{ background: "#13101A", border: "1px solid #1E1B26" }}
    >
      {Icon ? (
        <div className="mb-4 inline-flex items-center justify-center ade-empty-state-icon">
          <Icon size={iconSize} weight="regular" className="text-[#52525B]" />
        </div>
      ) : null}
      <div
        className="text-[14px] font-bold tracking-[-0.3px] text-[#FAFAFA] ade-empty-state-title"
        style={{ fontFamily: "var(--ade-font-sans, var(--font-sans))" }}
      >
        {title}
      </div>
      {description ? (
        <div className="mt-2 font-mono text-[11px] text-[#71717A] max-w-[45ch] mx-auto leading-relaxed ade-empty-state-description">
          {description}
        </div>
      ) : null}
      {children}
    </div>
  );
}
