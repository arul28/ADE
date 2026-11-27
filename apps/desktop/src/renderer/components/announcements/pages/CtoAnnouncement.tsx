import { Crown } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import shot from "./assets/cto-v2.webp";
import { BRAND } from "../../../../shared/brand";

/** CTO v2: one CTO per project that remembers, runs routines, and lives on a machine you pick. */
export default function CtoAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Crown size={17} weight="fill" color="#f59e0b" />, name: "CTO" }}
      headline="A CTO that remembers."
      sentence={`Tell it once and it remembers. It runs work on a schedule and lives on a machine you pick: this computer or ${BRAND.CLOUD_NAME}.`}
      action={{ tipId: "cto", label: "Open CTO" }}
      media={{
        kind: "images",
        width: 1280,
        height: 600,
        images: [{ src: shot, alt: "The CTO saying hi, with starters and what it remembers" }],
      }}
    />
  );
}
