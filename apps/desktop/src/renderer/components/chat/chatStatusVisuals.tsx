import { CheckCircle, SpinnerGap, XCircle } from "@phosphor-icons/react";
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
}: {
  status: ChatStatusVisualState;
  size?: number;
  className?: string;
}) {
  switch (status) {
    case "completed":
      return <CheckCircle size={size} weight="bold" className={cn("text-emerald-400", className)} />;
    case "failed":
      return <XCircle size={size} weight="bold" className={cn("text-red-400", className)} />;
    case "waiting":
      return <SpinnerGap size={size} weight="bold" className={cn("animate-spin text-amber-400", className)} />;
    case "working":
      return <SpinnerGap size={size} weight="bold" className={cn("animate-spin text-emerald-400", className)} />;
  }
}
