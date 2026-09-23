/** The pane's "Couldn't attach the image" message, with a dismiss button. */
export function TerminalImagePasteNotice({
  notice,
  onDismiss,
}: {
  notice: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-ade-terminal-image-paste-notice
      className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-lg border border-border/15 bg-card/95 backdrop-blur-sm shadow-card px-2 py-1 text-[11px] text-fg"
    >
      <span className="min-w-0 break-words">{notice}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss image paste message"
        className="rounded px-1 text-muted-fg transition-colors hover:text-fg"
      >
        ×
      </button>
    </div>
  );
}
