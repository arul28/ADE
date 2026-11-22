import { AppleLogo } from "../ui/appleIcons";

/**
 * One centred card in an Apple device pane: a title and an optional line. Its
 * own small module so the ADE Cloud iPhone pane doesn't load the Mac
 * simulator's pane to show it.
 */
export function PaneMessage({ title, description }: { title: string; description: string | null }) {
  return (
    <div
      data-apple-pane-message=""
      className="ade-tool-picker-static flex size-full items-center justify-center px-6 py-10"
    >
      <div className="ade-tool-card flex w-full min-w-0 max-w-sm flex-col items-center gap-2 p-6 text-center">
        <AppleLogo size={28} aria-hidden="true" className="text-muted-fg/60" />
        <p className="min-w-0 break-words font-sans text-sm font-medium leading-5 text-fg">{title}</p>
        {description ? (
          <p className="min-w-0 break-words font-sans text-xs leading-5 text-muted-fg">{description}</p>
        ) : null}
      </div>
    </div>
  );
}
