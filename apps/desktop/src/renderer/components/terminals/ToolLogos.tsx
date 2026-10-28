import React from "react";
import { Claude, Codex, Cursor, GithubCopilot, Grok, Kimi, OpenCode, Qwen } from "@lobehub/icons";
import type { TerminalToolType } from "../../../shared/types";
import { cn } from "../ui/cn";
import { DevinLogo, DroidLogo, MuseLogo, PiLogo, ProviderLogo } from "../shared/ProviderLogos";
import droidMarkSrc from "../../assets/provider-logos/droid-mark.svg";
import piMarkSrc from "../../assets/provider-logos/pi.svg";
import museGlyphSrc from "@lobehub/icons-static-svg/icons/meta.svg";

type LogoProps = { size?: number; className?: string; appearance?: "default" | "provider-mark" };

function lobeMarkClass(className?: string) {
  return cn("shrink-0 inline-flex [&_svg]:max-h-none [&_svg]:max-w-none", className);
}

function MaskedProviderMark({ src, color, size }: { src: string; color: string; size: number }) {
  const mask = `url(${src})`;
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        maskImage: mask,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskImage: mask,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
      }}
    />
  );
}

export const ClaudeLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <Claude.Color size={size} className={lobeMarkClass(className)} />
    : <Claude.Avatar size={size} className={lobeMarkClass(className)} />
);

export const CodexLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <Codex size={size} className={lobeMarkClass(className)} style={{ color: "#78D6B1" }} />
    : <Codex.Avatar size={size} className={lobeMarkClass(cn("opacity-95", className))} />
);

// Round, like every provider avatar, so a shell row keeps the logo column.
export const ShellLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    className={cn("shrink-0 text-zinc-300", className)}
  >
    <circle cx="12" cy="12" r="12" fill="currentColor" opacity="0.22" />
    <path
      d="M7.5 9l3 3-3 3M12 15.25h4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const CursorAgentLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <Cursor size={size} className={lobeMarkClass(className)} style={{ color: "#62B6FF" }} />
    : <Cursor.Avatar size={size} className={lobeMarkClass(className)} />
);

export const OpenCodeLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <OpenCode size={size} className={lobeMarkClass(className)} style={{ color: "#FF9A6B" }} />
    : <OpenCode.Avatar size={size} className={lobeMarkClass(className)} />
);

export const CopilotLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <GithubCopilot size={size} className={lobeMarkClass(className)} style={{ color: "#65D4C1" }} />
    : <GithubCopilot.Avatar size={size} className={lobeMarkClass(className)} />
);

export const QwenLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <Qwen.Color size={size} className={lobeMarkClass(className)} />
);

export const KimiLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <Kimi.Color size={size} className={lobeMarkClass(cn(className, "ade-mark-kimi"))} />
);

export const GrokLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <Grok size={size} className={lobeMarkClass(className)} style={{ color: "#D69BFF" }} />
    : <Grok.Avatar size={size} className={lobeMarkClass(className)} />
);

const DroidToolLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <MaskedProviderMark src={droidMarkSrc} color="#FF9B66" size={size} />
    : <DroidLogo size={size} className={className} />
);

const PiToolLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <MaskedProviderMark src={piMarkSrc} color="#B99AFF" size={size} />
    : <PiLogo size={size} className={className} />
);

export const MuseToolLogo: React.FC<LogoProps> = ({ size = 16, className, appearance }) => (
  appearance === "provider-mark"
    ? <MaskedProviderMark src={museGlyphSrc} color="#4A9BFF" size={size} />
    : <MuseLogo size={size} className={className} />
);

export const DevinToolLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <DevinLogo size={size} className={className} />
);

const AntigravityToolLogo: React.FC<LogoProps> = ({ size = 16, className }) => (
  <ProviderLogo family="antigravity" size={size} className={className} />
);

const USAGE_PROVIDER_LOGOS = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  cursor: CursorAgentLogo,
  copilot: CopilotLogo,
  grok: GrokLogo,
  opencode: OpenCodeLogo,
  kimi: KimiLogo,
  muse: MuseToolLogo,
} as const;

export function usageProviderLogo(
  provider: keyof typeof USAGE_PROVIDER_LOGOS,
): React.FC<LogoProps> {
  return USAGE_PROVIDER_LOGOS[provider];
}

const LOGO_MAP: Partial<Record<TerminalToolType, React.FC<LogoProps>>> = {
  claude: ClaudeLogo,
  "claude-chat": ClaudeLogo,
  "claude-orchestrated": ClaudeLogo,
  codex: CodexLogo,
  "codex-chat": CodexLogo,
  "codex-orchestrated": CodexLogo,
  cursor: CursorAgentLogo,
  "cursor-cli": CursorAgentLogo,
  droid: DroidToolLogo,
  "droid-chat": DroidToolLogo,
  opencode: OpenCodeLogo,
  "opencode-chat": OpenCodeLogo,
  "opencode-orchestrated": OpenCodeLogo,
  pi: PiToolLogo,
  "pi-chat": PiToolLogo,
  muse: MuseToolLogo,
  "muse-chat": MuseToolLogo,
  qwen: QwenLogo,
  "qwen-chat": QwenLogo,
  kimi: KimiLogo,
  "kimi-chat": KimiLogo,
  grok: GrokLogo,
  "grok-chat": GrokLogo,
  copilot: CopilotLogo,
  "copilot-chat": CopilotLogo,
  devin: DevinToolLogo,
  "devin-chat": DevinToolLogo,
  "antigravity-chat": AntigravityToolLogo,
  shell: ShellLogo,
};

export function ToolLogo({
  toolType,
  size = 16,
  className,
  appearance = "default",
}: {
  toolType: TerminalToolType | null | undefined;
  size?: number;
  className?: string;
  appearance?: "default" | "provider-mark";
}) {
  const Logo = toolType ? LOGO_MAP[toolType] : undefined;
  if (Logo) return <Logo size={size} className={className} appearance={appearance} />;
  return <ShellLogo size={size} className={className} />;
}
