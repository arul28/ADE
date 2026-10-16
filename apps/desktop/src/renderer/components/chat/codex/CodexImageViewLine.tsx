import { useState } from "react";
import { ImageSquare } from "@phosphor-icons/react";
import type { AgentChatEvent } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { ACTION_ROW_GRID, ACTION_ROW_TEXT, ActionLineToggle, StatusIcon } from "../ChatComputerUseActions";
import { PROOF_THUMBNAIL_HEIGHT } from "../chatComputerUseRows";
import { imageViewHasPicture, imageViewName } from "../../../../shared/chatImageUrls";
import { ViewedImageStrip } from "../ChatViewedImages";
import { isScenePreviewImagePath } from "../ScenePreviewThumb";

type ImageViewEvent = Extract<AgentChatEvent, { type: "codex_image_view" }>;

type CodexImageViewLineProps = {
  event: ImageViewEvent;
  /** Later image views folded into this row by adjacency (`imageViewSiblings`). */
  siblings?: ImageViewEvent[];
};

/**
 * An image the agent opened that no computer-use action of its turn wrote (a
 * file it read, a crop it made), as one quiet line in the grid of the action
 * rows around it: "Viewed banner.png", or "Viewed 3 images" for a run of them.
 * A screenshot an action took joins that action's line instead
 * (`foldImageViewIntoAction`).
 *
 * The line is all that shows. The agent needed to see the picture; the reader
 * rarely does, and gets the turn's proof at its end. A click opens the
 * pictures small under the line, and a click on one shows it full size.
 */
export function CodexImageViewLine({ event, siblings }: CodexImageViewLineProps) {
  // An agent opening the screenshot of a scene it is drafting is checking its
  // work, not showing the reader anything: one line, no picture. A still of
  // the scene in the transcript reads as the scene itself, frozen, and the
  // live one arrives in the reply.
  if (onlyScenePreviews([event, ...(siblings ?? [])])) {
    const count = 1 + (siblings?.length ?? 0);
    return (
      <div className="flex items-center gap-2 pl-6 text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/45">
        <span aria-hidden className="select-none text-fg/30">{"↳"}</span>
        <span>{count === 1 ? "Checked the scene preview" : `Checked the scene preview ${count} times`}</span>
      </div>
    );
  }
  return <ImageViewLine event={event} siblings={siblings} />;
}

/** True when every image in the run is an agent looking at its own scene preview. */
function onlyScenePreviews(events: ReadonlyArray<ImageViewEvent>): boolean {
  // Providers name the file in different fields: Codex in `path` (or a
  // file:// `url`), OpenCode in `title` with the image inlined and omitted.
  return events.every((item) => [item.path, item.url, item.title].some(isScenePreviewImagePath));
}

function ImageViewLine({ event, siblings }: CodexImageViewLineProps) {
  const [open, setOpen] = useState(false);
  const views = siblings?.length ? [event, ...siblings] : [event];
  const pictures = views.filter(imageViewHasPicture);
  const running = views.some((view) => view.status === "running");
  const failed = !running && views.every((view) => view.status === "failed");
  const names = views.map(imageViewName);
  const object = views.length > 1 ? `${views.length} images` : names[0]!;
  const lead = running ? "Viewing" : failed ? "Couldn't view" : "Viewed";
  const words = (
    <span
      className={cn("min-w-0 truncate leading-[1.5] text-muted-fg", ACTION_ROW_TEXT, running && "ade-thinking-shimmer")}
      title={names.join(", ")}
    >
      {lead} {object}
      {running ? "…" : null}
    </span>
  );
  return (
    <div className="w-full min-w-0 max-w-[var(--chat-content-width,52rem)] font-sans" data-testid="image-view-line">
      <div className={cn(ACTION_ROW_GRID, "py-0.5")}>
        <span aria-hidden className="inline-flex shrink-0 items-center justify-center justify-self-center text-muted-fg">
          <ImageSquare size={13} weight="regular" />
        </span>
        {pictures.length
          ? <ActionLineToggle open={open} onToggle={() => setOpen((value) => !value)}>{words}</ActionLineToggle>
          : <span className={cn("inline-flex min-w-0 items-center", ACTION_ROW_TEXT)}>{words}</span>}
        <StatusIcon outcome={running ? "running" : failed ? "failed" : "observed"} />
        {open && pictures.length ? (
          <span className="col-start-1 col-end-4 mb-1 mt-1.5 flex min-w-0">
            <ViewedImageStrip views={pictures} height={PROOF_THUMBNAIL_HEIGHT} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default CodexImageViewLine;
