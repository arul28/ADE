import { useCallback, useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { Claude, Codex, Cursor, GithubCopilot, Grok, Kimi, OpenCode, Qwen } from "@lobehub/icons";
import { cn } from "../../ui/cn";
import { PiLogo } from "../../shared/ProviderLogos";
import type { ExternalSessionProvider } from "../../../../shared/types/externalSessions";
import { EXTERNAL_SESSION_PROVIDERS } from "../../../../shared/types/externalSessions";
import droidMarkSrc from "../../../assets/provider-logos/droid-mark.svg";

const STORAGE_PREFIX = "ade.importChatsBadge.dismissed:";

export function importBadgeStorageKey(projectRoot: string): string {
  return `${STORAGE_PREFIX}${projectRoot}`;
}

export function readImportBadgeDismissed(projectRoot: string | null | undefined): boolean {
  if (!projectRoot || typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(importBadgeStorageKey(projectRoot)) === "1";
  } catch {
    return false;
  }
}

export function writeImportBadgeDismissed(projectRoot: string): void {
  try {
    localStorage.setItem(importBadgeStorageKey(projectRoot), "1");
  } catch {
    // Machine-local only; quota or private mode just keeps the pill visible.
  }
}

function ExternalProviderMark({ provider }: { provider: ExternalSessionProvider }) {
  const monoStyle = (color: string) => ({ color });
  switch (provider) {
    case "claude": return <Claude.Color size={20} />;
    case "codex": return <Codex size={20} style={monoStyle("#A7B4FF")} />;
    case "cursor": return <Cursor size={20} style={monoStyle("#A7B4FF")} />;
    case "droid": return <img src={droidMarkSrc} alt="" width={20} height={20} className="brightness-0 invert" />;
    case "opencode": return <OpenCode size={20} style={monoStyle("#F5F3FF")} />;
    case "pi": return <PiLogo size={20} className="brightness-0 invert" />;
    case "qwen": return <Qwen.Color size={20} />;
    case "kimi": return <Kimi.Color size={20} />;
    case "grok": return <Grok size={20} style={monoStyle("#F5F3FF")} />;
    case "copilot": return <GithubCopilot size={20} style={monoStyle("#7DD3FC")} />;
  }
  return null;
}

export function ImportFloatingBadge({
  projectRoot,
  disabled = false,
  onOpen,
}: {
  projectRoot: string | null | undefined;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => readImportBadgeDismissed(projectRoot));

  useEffect(() => {
    setDismissed(readImportBadgeDismissed(projectRoot));
  }, [projectRoot]);

  const dismiss = useCallback(() => {
    if (projectRoot) writeImportBadgeDismissed(projectRoot);
    setDismissed(true);
  }, [projectRoot]);

  // Acting on the hint retires it too: once the modal has been opened from
  // here the pill has done its one job for this project on this machine, and
  // keeping it around would nag every time the draft composer is empty.
  const open = useCallback(() => {
    dismiss();
    onOpen();
  }, [dismiss, onOpen]);

  if (!projectRoot || dismissed) return null;

  return (
    // `shrink-0` because the draft column this sits in is a height-capped
    // flex-col where the logo is the only row meant to absorb overflow. The
    // top margin sets the hint apart from the activity card above it, so it
    // reads as a footnote to the column rather than part of that card. Short
    // windows drop it: the column is already at its floor there, and the extra
    // gap would only push the pill further past the bottom edge.
    <div className="flex w-full shrink-0 justify-center [@media(min-height:760px)]:mt-6">
      <div
        // Fades out with the rest of the draft when a sent chat opens (`chatLaunchDock`).
        data-draft-depart="fade"
        className={cn(
          "import-chat-pill relative inline-flex min-w-0 max-w-full items-center gap-3 rounded-full border border-violet-300/25 bg-gradient-to-r from-violet-500/18 via-[#1A1830] to-cyan-400/12 px-3 py-1.5 shadow-[0_10px_28px_rgba(88,28,135,0.28)]",
          disabled ? "opacity-40" : "transition-transform hover:-translate-y-px",
        )}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={open}
          className="import-chat-pill__action inline-flex min-w-0 max-w-full items-center gap-3 disabled:cursor-not-allowed"
          aria-label="Import your chats from outside ADE"
        >
          <span className="import-chat-pill__providers flex h-7 shrink-0 items-center gap-1">
            {EXTERNAL_SESSION_PROVIDERS.map((provider) => (
              <span
                key={provider}
                className="import-chat-pill__provider inline-flex h-6 w-6 shrink-0 items-center justify-center"
              >
                <ExternalProviderMark provider={provider} />
              </span>
            ))}
          </span>
          <span className="import-chat-pill__label shrink-0 text-left text-[12px] font-medium tracking-tight text-fg/90">
            Import your chats from outside ADE
          </span>
        </button>
        <button
          type="button"
          aria-label="Hide import hint"
          onClick={dismiss}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-fg/70 opacity-70 transition-opacity hover:bg-white/10 hover:text-fg hover:opacity-100"
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
}
