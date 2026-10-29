import { UserCircle } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import accounts from "./assets/provider-accounts.webp";

export default function ProviderAccountsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <UserCircle size={17} weight="fill" />, name: "AI connections" }}
      headline="Manage your accounts in detail."
      sentence="Add multiple accounts, check usage and settings, and see what goes into your agent's context when a chat starts."
      action={{ tipId: "another-account", label: "Open AI connections" }}
      media={{
        kind: "images",
        width: 1370,
        height: 900,
        images: [{ src: accounts, alt: "Claude settings showing sample accounts, usage and initial context" }],
      }}
    />
  );
}
