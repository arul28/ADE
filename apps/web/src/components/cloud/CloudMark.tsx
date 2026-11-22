import { useId } from "react";
import { cn } from "../../lib/cn";

/** The cloud outline the mark and the hero sky share. */
export const CLOUD_PATH =
  "M9 21H24A5.5 5.5 0 0 0 24.6 10.03A7.5 7.5 0 0 0 10.4 8.2A6.5 6.5 0 0 0 9 21Z";

/**
 * ADE Cloud's mark: a violet cloud with one lit window, the same lamp gold as
 * the night city's windows. One lit window is one agent at work.
 */
export function CloudMark({ className, title }: { className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="1 3 30 20"
      overflow="visible"
      className={cn("h-5 w-auto", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="55%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#db2777" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="1.1" />
        </filter>
      </defs>
      <path d={CLOUD_PATH} fill={`url(#${id}-fill)`} />
      <path d={CLOUD_PATH} fill="none" stroke="white" strokeOpacity="0.35" strokeWidth="0.6" />
      <rect x="15" y="12.2" width="4.4" height="4.4" rx="0.9" fill="#ffd27a" filter={`url(#${id}-glow)`} opacity="0.9" />
      <rect x="15" y="12.2" width="4.4" height="4.4" rx="0.9" fill="#ffd27a" />
    </svg>
  );
}

/** The mark with the name beside it. */
export function CloudLockup({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-[-0.01em]", className)}>
      <CloudMark className={markClassName} />
      ADE Cloud
    </span>
  );
}
