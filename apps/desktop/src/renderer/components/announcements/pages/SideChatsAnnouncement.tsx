import { ChatsCircle, Eye, PaperPlaneTilt, TerminalWindow } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import gif from "./assets/side-chat.gif";
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
      action={{ tipId: "side-chats", label: "Try /side" }}
      media={{
        gif,
        still,
        width: 900,
        height: 565,
        alt: "Typing /side in a chat opens a side chat that answers, then sends a note to the main chat",
      }}
    />
  );
}
