import React from "react";
import { Claude, Codex, Cursor } from "@lobehub/icons";
import type { TerminalToolType } from "../../../shared/types";
import { cn } from "../ui/cn";

type LogoProps = { size?: number; className?: string };

function lobeMarkClass(className?: string) {
  return cn("shrink-0 inline-flex [&_svg]:max-h-none [&_svg]:max-w-none", className);
}

export const ClaudeLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <Claude.Avatar size={size} className={lobeMarkClass(className)} />
);

export const CodexLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <Codex.Avatar size={size} className={lobeMarkClass(cn("opacity-95", className))} />
);

export const ShellLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 256 210"
    xmlns="http://www.w3.org/2000/svg"
    className={cn("shrink-0 text-zinc-400", className)}
  >
    <rect width="256" height="209.342" rx="5" fill="currentColor" opacity="0.3" />
    <path
      d="M28.24 21.77a4.38 4.38 0 0 0-3.1-1.28c-1.21 0-2.25.43-3.11 1.3-.85.85-1.28 1.89-1.28 3.1s.43 2.25 1.28 3.1l13.44 13.44-13.43 13.43c-.86.86-1.3 1.9-1.31 3.11.01 1.21.44 2.25 1.3 3.1.86.85 1.9 1.28 3.1 1.3 1.22 0 2.26-.44 3.12-1.3l14.94-14.95c3.13-3.12 3.13-6.26 0-9.39L28.24 21.77zm58.55 33.1c-.87-.86-1.91-1.3-3.14-1.3v-.01H54.82v.01c-1.22 0-2.26.43-3.12 1.3-.87.86-1.3 1.9-1.3 3.12 0 1.22.43 2.27 1.3 3.14.86.86 1.9 1.3 3.12 1.3v-.01h28.83v.01c1.22 0 2.27-.43 3.14-1.3.86-.86 1.3-1.91 1.3-3.14 0-1.22-.44-2.26-1.3-3.12z"
      fill="currentColor"
    />
  </svg>
);

export const CursorAgentLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <Cursor.Avatar size={size} className={lobeMarkClass(className)} />
);

export const AiChatLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn("shrink-0", className)}
  >
    <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ai-chat-g)" />
    <path d="M12 6.5l1.25 3.25L16.5 11l-3.25 1.25L12 15.5l-1.25-3.25L7.5 11l3.25-1.25L12 6.5z" fill="#ECFEFF" />
    <circle cx="17.75" cy="6.5" r="1.1" fill="#CCFBF1" />
    <circle cx="6.25" cy="17.5" r="1.1" fill="#99F6E4" />
    <defs>
      <linearGradient id="ai-chat-g" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
        <stop stopColor="#14B8A6" />
        <stop offset="1" stopColor="#0D9488" />
      </linearGradient>
    </defs>
  </svg>
);

const LOGO_MAP: Partial<Record<TerminalToolType, React.FC<LogoProps>>> = {
  claude: ClaudeLogo,
  "claude-chat": ClaudeLogo,
  "claude-orchestrated": ClaudeLogo,
  codex: CodexLogo,
  "codex-chat": CodexLogo,
  "codex-orchestrated": CodexLogo,
  cursor: CursorAgentLogo,
  "ai-chat": AiChatLogo,
  shell: ShellLogo,
};

export function ToolLogo({
  toolType,
  size = 16,
  className,
}: {
  toolType: TerminalToolType | null | undefined;
  size?: number;
  className?: string;
}) {
  const Logo = toolType ? LOGO_MAP[toolType] : undefined;
  if (Logo) return <Logo size={size} className={className} />;
  return <ShellLogo size={size} className={className} />;
}
