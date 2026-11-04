import { UserCircle } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import accounts from "./assets/provider-accounts.webp";

export default function ProviderAccountsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <UserCircle size={17} weight="fill" />, name: "Providers" }}
      headline="Every account, in full detail."
      sentence="Add accounts, check their usage, and see what a new chat starts with, in Settings › Providers."
      action={{ tipId: "another-account", label: "Open Providers" }}
      media={{
        kind: "images",
        width: 1370,
        height: 900,
        images: [{ src: accounts, alt: "Claude settings showing sample accounts, usage and initial context" }],
      }}
    />
  );
}
