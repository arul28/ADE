import { useCallback, useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { ToolLogo } from "../ToolLogos";
import { ALL_IMPORT_PROVIDERS, PROVIDER_TOOL_TYPE } from "./contract";

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
    // flex-col where the logo is the only row meant to absorb overflow.
    <div className="flex w-full shrink-0 justify-center">
      <div
        className={cn(
          "relative inline-flex items-center gap-3 rounded-full border border-violet-300/25 bg-gradient-to-r from-violet-500/18 via-[#1A1830] to-cyan-400/12 px-3 py-1.5 shadow-[0_10px_28px_rgba(88,28,135,0.28)]",
          disabled ? "opacity-40" : "transition-transform hover:-translate-y-px",
        )}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={open}
          className="inline-flex items-center gap-3 disabled:cursor-not-allowed"
          aria-label="Import your chats from outside ADE"
        >
          <span className="relative flex h-7 w-[92px] shrink-0 items-center">
            {ALL_IMPORT_PROVIDERS.map((provider, index) => (
              <span
                key={provider}
                className="absolute rounded-full border border-black/40 bg-[#12101C] shadow-sm"
                style={{
                  left: index * 12,
                  transform: `rotate(${index % 2 === 0 ? -8 : 7}deg)`,
                  zIndex: ALL_IMPORT_PROVIDERS.length - index,
                }}
              >
                <ToolLogo toolType={PROVIDER_TOOL_TYPE[provider]} size={22} />
              </span>
            ))}
          </span>
          <span className="pr-5 text-left text-[12px] font-medium tracking-tight text-fg/90">
            Import your chats from outside ADE
          </span>
        </button>
        <button
          type="button"
          aria-label="Hide import hint"
          onClick={dismiss}
          className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-fg/70 opacity-70 transition-opacity hover:bg-white/10 hover:text-fg hover:opacity-100"
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
}
