import { X } from "@phosphor-icons/react";
import { EditorTargetLogo } from "../ui/EditorTargetLogo";

/**
 * The pill over the transcript when a Cursor chat has no Cursor runtime. It
 * links to the Cursor provider settings and the user can dismiss it.
 */
export function CursorRuntimeNotice({
  onOpenSettings,
  onDismiss,
}: {
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-3">
      <div
        role="status"
        data-testid="cursor-runtime-notice"
        className="pointer-events-auto flex max-w-[28rem] items-center gap-2 rounded-full border border-violet-300/30 bg-violet-500/20 px-2.5 py-1 shadow-[0_10px_28px_rgba(0,0,0,0.35)] backdrop-blur-md"
      >
        <EditorTargetLogo target="cursor" size={14} />
        <p className="min-w-0 truncate font-sans text-[12px] leading-5 text-violet-50/95">
          Cursor runtime is not available,{" "}
          <button
            type="button"
            className="underline decoration-violet-200/70 underline-offset-2 hover:text-white"
            onClick={onOpenSettings}
          >
            click here
          </button>
          {" "}to setup
        </p>
        <button
          type="button"
          aria-label="Dismiss Cursor runtime notice"
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-violet-100/75 transition-colors hover:bg-white/10 hover:text-white"
          onClick={onDismiss}
        >
          <X size={12} weight="bold" aria-hidden />
        </button>
      </div>
    </div>
  );
}
