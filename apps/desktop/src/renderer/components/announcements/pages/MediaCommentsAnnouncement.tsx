import { ChatCenteredText } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import video from "./assets/media-comments.mp4";
import still from "./assets/media-comments-still.webp";

/** Comments on the images and videos in a reply, and Add to chat. */
export default function MediaCommentsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <ChatCenteredText size={17} weight="fill" />, name: "Chat" }}
      headline="Comment on screenshots and videos."
      sentence="Hover an image or video in a reply to comment on it, or add it to your next message."
      action={{ tipId: "comments", label: "Try it" }}
      media={{
        video,
        still,
        width: 1600,
        height: 1000,
        alt: "A comment on a screenshot in a reply, a comment on a video, then Add to chat attaching the screenshot to the next message",
      }}
    />
  );
}
