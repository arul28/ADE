// Render message text with its special tokens drawn as compact pills.
//
// A sent message used to print `event.text` into a `whitespace-pre-wrap` div,
// so everything the composer had shown as a chip reverted to raw text the
// moment it was sent: a full github.com URL, an opaque `@chat:<uuid>`, a long
// repo path. The composer and the transcript disagreed about the same message.
//
// This component closes that gap using the shared chip model, so the composer,
// the transcript, the TUI, and iOS all read one description of what a chip is.
// The raw text is never destroyed — it is still `event.text`, the copy button
// still yields canonical tokens, and a chip's `title` shows the token it stands
// for.

import { buildDeeplink } from "../../../shared/deeplinks";
import { chipDisplayLabel, chipGlyph, splitTextIntoChipParts, type Chip } from "../../../shared/chips";
import { navigateToAppTarget, openAdeDeeplink, openLinkFromUi } from "../../lib/openExternal";

/** Where a click on this chip should land, or null when it is not actionable. */
function openChip(chip: Chip): void {
  const source = chip.source;
  if (source.origin === "deeplink") {
    openAdeDeeplink(source.url);
    return;
  }
  if (source.origin === "url") {
    openLinkFromUi(source.url);
    return;
  }
  if (source.origin === "path") {
    navigateToAppTarget({ kind: "file", path: source.path, line: null, laneId: null });
    return;
  }
  if (source.mentionKind === "chat") {
    openAdeDeeplink(buildDeeplink({ kind: "session", sessionId: source.id }));
    return;
  }
  if (source.mentionKind === "lane") {
    openAdeDeeplink(buildDeeplink({ kind: "lane", laneId: source.id }));
  }
  // A terminal mention has no deeplink target; it stays a label.
}

function isActionable(chip: Chip): boolean {
  return chip.source.origin !== "mention" || chip.source.mentionKind !== "terminal";
}

const CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[280px] translate-y-[1px] items-center gap-1 rounded-md border border-white/[0.14]"
  + " bg-white/[0.08] px-1.5 py-0.5 align-baseline font-sans text-[length:calc(var(--chat-font-size)*11/14)]"
  + " leading-5 text-white/90";

export function ChipText({ text, className }: { text: string; className?: string }) {
  const parts = splitTextIntoChipParts(text);

  // No chips: keep the exact original node so nothing about plain messages
  // changes — spacing, selection, and copy stay byte-for-byte what they were.
  if (parts.every((part) => part.type === "text")) {
    return <div className={className}>{text}</div>;
  }

  return (
    <div className={className}>
      {parts.map((part, index) => {
        if (part.type === "text") return <span key={`t-${index}`}>{part.text}</span>;
        const chip = part.chip;
        const label = chipDisplayLabel(chip);
        const actionable = isActionable(chip);
        return (
          <span
            key={`c-${index}`}
            className={`${CHIP_CLASS}${actionable ? " cursor-pointer transition-colors hover:bg-white/[0.14]" : ""}`}
            // The token is the truth behind the label; a hover always reveals it.
            title={chip.detail ? `${chip.token} — ${chip.detail}` : chip.token}
            role={actionable ? "button" : undefined}
            tabIndex={actionable ? 0 : undefined}
            onClick={actionable ? () => openChip(chip) : undefined}
            onKeyDown={actionable
              ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                openChip(chip);
              }
              : undefined}
          >
            <span aria-hidden className="shrink-0 opacity-70">{chipGlyph(chip.kind)}</span>
            <span className="truncate">{label}</span>
          </span>
        );
      })}
    </div>
  );
}
