import { CheckCircle, Clock, SpinnerGap, XCircle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

export type ChatStatusVisualState = "working" | "waiting" | "completed" | "failed";

export const CHAT_STATUS_HEX = {
  working: "#10B981",
  waiting: "#F59E0B",
  completed: "#10B981",
  failed: "#EF4444",
  idle: "#6B7280",
} as const;

export function chatStatusTextClass(status: ChatStatusVisualState): string {
  switch (status) {
    case "completed":
      return "text-emerald-300/75";
    case "failed":
      return "text-red-300/80";
    case "waiting":
      return "text-amber-300/80";
    default:
      return "text-emerald-300/80";
  }
}

export function ChatStatusGlyph({
  status,
  size = 12,
  className,
  animate = true,
}: {
  status: ChatStatusVisualState;
  size?: number;
  className?: string;
  animate?: boolean;
}) {
  switch (status) {
    case "completed":
      return (
        <span className={cn("inline-flex ade-fade-in", className)}>
          <CheckCircle size={size} weight="fill" className="text-emerald-400" />
        </span>
      );
    case "failed":
      return (
        <span className={cn("inline-flex ade-fade-in", className)}>
          <XCircle size={size} weight="fill" className="text-red-400" />
        </span>
      );
    case "waiting":
      return <Clock size={size} weight="bold" className={cn("text-amber-400", className)} />;
    case "working":
      return (
        <span className={cn("relative inline-flex items-center justify-center", className)}>
          {animate ? (
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/20" style={{ animationDuration: '2s' }} />
          ) : null}
          <SpinnerGap size={size} weight="bold" className={cn(animate && "animate-spin", "text-emerald-400")} />
        </span>
      );
  }
}
