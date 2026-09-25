import { ImageSquare } from "@phosphor-icons/react";
import { Banner } from "../ui/notice";

/** The pane's "Couldn't attach the image" message, with a dismiss button. */
export function TerminalImagePasteNotice({
  notice,
  onDismiss,
}: {
  notice: string;
  onDismiss: () => void;
}) {
  // The wrapper only anchors the banner over the terminal's bottom-left corner
  // (and blurs the terminal text behind it); the Banner owns every visual.
  return (
    <div
      data-ade-terminal-image-paste-notice
      className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] rounded-[10px] backdrop-blur-sm"
    >
      <Banner
        layout="inline"
        model={{
          id: "terminal-image-paste",
          tone: "warning",
          icon: <ImageSquare size={13} weight="bold" />,
          title: notice,
          dismiss: { onDismiss, label: "Dismiss image paste message" },
        }}
      />
    </div>
  );
}
