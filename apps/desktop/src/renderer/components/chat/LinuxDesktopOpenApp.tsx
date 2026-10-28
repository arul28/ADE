import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleNotch } from "@phosphor-icons/react";

import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { INPUT_CLASS_NAME } from "../lanes/laneDialogTokens";
import { MacDesktopRowAction } from "./macDesktopWindowList";

/** One-click starts for what a Linux box usually has; the helper resolves each name. */
const SUGGESTIONS = ["Chrome", "Firefox", "Terminal"] as const;

/**
 * "Open an app" on a lane's Linux screen.
 *
 * A Linux lane screen is its own X display: there is no other screen whose
 * windows could be moved onto it, so the Mac picker ("choose a window to
 * move") has nothing to list. Opening is the way to add an app here, with
 * the same resolution `ade screen open` uses: an app name, a `.desktop`
 * entry, a path, or a URL (which opens in the lane's browser).
 */
export function LinuxDesktopOpenApp({
  onOpen,
  onClose,
}: {
  /** Resolves to an error sentence, or null once the app is starting. */
  onOpen: (target: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const open = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || pending) return;
    setPending(trimmed);
    setError(null);
    const failure = await onOpen(trimmed);
    setPending(null);
    if (failure) setError(failure);
    else onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void open(target);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="linux-desktop-open-app">
      <div className="flex items-start gap-2 px-4 pb-3 pt-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">Open an app on this screen</div>
          <div className="mt-0.5 text-[11.5px] text-muted-fg">
            An app name, a path, or a web address. Web addresses open in the lane's browser.
          </div>
        </div>
        <MacDesktopRowAction label="Close" onClick={onClose} />
      </div>
      <form className="flex items-center gap-2 px-4" onSubmit={submit}>
        <input
          ref={inputRef}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
          }}
          placeholder="firefox, /opt/app/run, https://example.com"
          aria-label="App, path or web address"
          className={cn(INPUT_CLASS_NAME, "min-w-0 flex-1")}
          disabled={pending != null}
        />
        <button
          type="submit"
          disabled={!target.trim() || pending != null}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-border px-3 text-[12px] text-fg",
            "transition-colors duration-[120ms] ease-out hover:bg-fg/[0.06] disabled:opacity-50",
          )}
        >
          {pending && pending === target.trim() ? <CircleNotch size={12} className="animate-spin" /> : null}
          Open
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
        {SUGGESTIONS.map((name) => (
          <button
            key={name}
            type="button"
            disabled={pending != null}
            onClick={() => void open(name)}
            className={cn(
              "flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-border/70 px-2 text-[11.5px] text-muted-fg",
              "transition-colors duration-[120ms] ease-out hover:bg-fg/[0.06] hover:text-fg disabled:opacity-50",
            )}
          >
            {pending === name ? <CircleNotch size={11} className="animate-spin" /> : null}
            {name}
          </button>
        ))}
      </div>
      {error ? (
        <Banner
          layout="inline"
          style={{ margin: "12px 16px 0" }}
          model={{
            id: "linux-desktop-open-app-error",
            tone: "error",
            title: error,
            report: { surface: "linux_desktop_open_app" },
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
    </div>
  );
}
