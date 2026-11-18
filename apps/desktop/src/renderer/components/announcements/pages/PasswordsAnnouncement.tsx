import { LockKey } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import shot from "./assets/passwords.webp";

/** Passwords & Secrets: logins, codes, passkeys and keys that agents use but never see. */
export default function PasswordsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <LockKey size={17} weight="fill" color="#14b8a6" />, name: "Passwords & Secrets" }}
      headline="Logins your agents can use."
      sentence="Save logins, 2FA codes, passkeys and API keys, encrypted on your account. Agents use them without ever seeing them."
      action={{ tipId: "secrets", label: "Open Passwords & Secrets" }}
      media={{
        kind: "images",
        width: 1180,
        height: 470,
        images: [{ src: shot, alt: "Passwords & Secrets: three logins, one with a live 2FA code" }],
      }}
    />
  );
}
