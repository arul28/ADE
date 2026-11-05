import { Desktop } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import chats from "./assets/chats-every-machine.webp";

/** The Chats tab lists chats from every connected machine. */
export default function ChatsEveryMachineAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Desktop size={17} weight="fill" />, name: "Chats" }}
      headline="Every chat, from every computer."
      sentence="Chats lists every machine you connect. Open any chat and keep going."
      action={{ tipId: "connect-machine", label: "Connect a computer" }}
      media={{
        kind: "images",
        width: 1460,
        height: 846,
        images: [{ src: chats, alt: "The Chats tab with chats from this computer and a MacBook Pro, one of them open" }],
      }}
    />
  );
}
