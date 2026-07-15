import type { ReactNode } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";

const ORCHESTRATOR_COMPOSER_GRADIENT =
  "conic-gradient(from 0deg, #ff5f5f, #ff9b3f, #f7d05c, #59d97f, #4f93ff, #a566ff, #ff5f5f)";

export function ChatComposerShell({
  mode,
  glowColor,
  orchestratorActive = false,
  pendingBanner,
  trays,
  pickerLayer,
  children,
  footer,
  className,
}: {
  mode: ChatSurfaceMode;
  glowColor?: string | null;
  orchestratorActive?: boolean;
  pendingBanner?: ReactNode;
  trays?: ReactNode;
  pickerLayer?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "ade-liquid-glass ade-liquid-glass-strong relative w-full min-w-0 max-w-full rounded-[var(--chat-radius-shell)] transition-colors",
        className,
      )}
      style={glowColor ? {
        boxShadow: `0 0 24px -6px ${glowColor}, 0 0 48px -16px ${glowColor}, 0 26px 64px -34px rgba(0,0,0,0.72), 0 0 0 1px color-mix(in srgb, ${glowColor} 30%, rgba(255,255,255,0.04))`,
        borderColor: `color-mix(in srgb, ${glowColor} 30%, transparent)`,
      } : undefined}
      data-chat-composer-mode={mode}
      data-chat-composer-orchestrator-active={orchestratorActive ? "true" : undefined}
    >
      {orchestratorActive ? (
        <div
          data-chat-composer-orchestrator-glow=""
          aria-hidden
          className="pointer-events-none absolute -inset-8 rounded-[calc(var(--chat-radius-shell)+24px)] blur-3xl"
          style={{
            background: ORCHESTRATOR_COMPOSER_GRADIENT,
            opacity: 0.34,
          }}
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[var(--chat-radius-shell)]">
        <div className="absolute left-6 top-0 h-24 w-32 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.05)_0%,transparent_72%)] opacity-50 blur-2xl" />
        <div className="absolute bottom-[-3rem] right-[-2rem] h-24 w-36 rounded-full bg-[radial-gradient(circle,var(--chat-liquid-sheen)_0%,transparent_70%)] opacity-50 blur-3xl" />
      </div>
      {pendingBanner ? <div className="relative min-w-0 max-w-full border-b border-[color:var(--chat-panel-border)]">{pendingBanner}</div> : null}
      {trays ? <div className="relative min-w-0 max-w-full border-b border-[color:var(--chat-panel-border)]">{trays}</div> : null}
      <div className="relative min-w-0 max-w-full">
        {pickerLayer}
        {children}
      </div>
      {footer ? <div className="relative min-w-0 max-w-full">{footer}</div> : null}
    </div>
  );
}
