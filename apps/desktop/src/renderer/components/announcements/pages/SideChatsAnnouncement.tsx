import { ChatsCircle, Eye, PaperPlaneTilt, TerminalWindow } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import video from "./assets/side-chat.mp4";
import still from "./assets/side-chat-still.webp";

/** `/side`: a read-only side chat that knows the conversation. */
export default function SideChatsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <ChatsCircle size={17} weight="fill" />, name: "Chat" }}
      headline="Ask a side question without derailing the chat."
      sentence="Type /side and your question. The side chat already knows the conversation, can't change anything, and passes a note back when you ask."
      marks={[
        { icon: <TerminalWindow size={14} weight="fill" />, label: "/side" },
        { icon: <Eye size={13} weight="bold" />, label: "Read-only" },
        { icon: <PaperPlaneTilt size={13} weight="fill" />, label: "Sends notes back" },
      ]}
      media={{
        video,
        still,
        width: 1600,
        height: 1004,
        alt: "Typing /side in a chat opens a side chat that answers, then sends a note to the main chat",
      }}
    />
  );
}
