import { Desktop, Laptop, WindowsLogo } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import chats from "./assets/chats-every-machine.webp";

/** The Chats tab lists chats from every connected machine. */
export default function ChatsEveryMachineAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Desktop size={17} weight="fill" />, name: "Chats" }}
      headline="All your chats, from every computer."
      sentence="Chats lists the chats on every computer you've connected. Open one and keep going; it still runs on the computer it lives on."
      marks={[
        { icon: <Desktop size={14} weight="fill" />, label: "Desktop" },
        { icon: <Laptop size={14} weight="fill" />, label: "Laptop" },
        { icon: <WindowsLogo size={14} weight="fill" color="#0078d4" />, label: "Windows PC" },
      ]}
      media={{
        kind: "images",
        width: 1460,
        height: 846,
        images: [{ src: chats, alt: "The Chats tab with chats from this computer and a MacBook Pro, one of them open" }],
      }}
    />
  );
}
