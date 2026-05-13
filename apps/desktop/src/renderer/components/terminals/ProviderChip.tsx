import type { HTMLAttributes } from "react";
import { PROVIDER_BADGE_COLORS, PROVIDER_GROUP_COLORS } from "../../../shared/modelCatalog";
import type { TerminalToolType } from "../../../shared/types";
import type { AgentChatProvider } from "../../../shared/types/chat";
import { chatToolTypeForProvider } from "../../lib/sessions";
import { cn } from "../ui/cn";
import { ToolLogo } from "./ToolLogos";

type ProviderChipSize = "sm" | "md";

export type ProviderChipProps = {
  provider: AgentChatProvider | string;
  toolType?: TerminalToolType | null;
  size?: ProviderChipSize;
  className?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

const SIZE_PX: Record<ProviderChipSize, number> = { sm: 18, md: 22 };

function resolveProviderColor(provider: string): string {
  return (
    PROVIDER_BADGE_COLORS[provider]
    ?? PROVIDER_GROUP_COLORS[provider as keyof typeof PROVIDER_GROUP_COLORS]
    ?? "#6B7280"
  );
}

export function ProviderChip({
  provider,
  toolType: explicitToolType,
  size = "md",
  className,
  style,
  ...rest
}: ProviderChipProps) {
  const diameter = SIZE_PX[size];
  const glyph = Math.round(diameter * 0.6);
  const bg = resolveProviderColor(String(provider));
  const toolType = explicitToolType ?? chatToolTypeForProvider(provider);
  return (
    <span
      {...rest}
      className={cn("inline-flex items-center justify-center rounded-full shrink-0", className)}
      style={{
        width: diameter,
        height: diameter,
        background: bg,
        color: "rgba(255,255,255,0.96)",
        ...style,
      }}
    >
      <ToolLogo toolType={toolType} size={glyph} className="text-white" />
    </span>
  );
}
