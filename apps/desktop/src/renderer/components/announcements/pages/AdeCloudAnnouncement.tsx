import { CloudArrowUp } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import shot from "./assets/ade-cloud.webp";
import { BRAND } from "../../../../shared/brand";

/** ADE Cloud: one machine in every account, and a cloud computer for each lane that runs there. */
export default function AdeCloudAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <CloudArrowUp size={17} weight="fill" color="#0ea5e9" />, name: BRAND.CLOUD_NAME }}
      headline="A machine of yours, in the cloud."
      sentence={`Every account has ${BRAND.CLOUD_NAME}, next to your own computers. Pick it in Run on and the lane gets its own cloud computer, from the web or your phone too.`}
      action={{ tipId: "ade-cloud", label: "Try it in a new chat" }}
      media={{
        kind: "images",
        width: 1360,
        height: 900,
        images: [{ src: shot, alt: `Providers on ${BRAND.CLOUD_NAME}: each sign-in shows where it came from` }],
      }}
    />
  );
}
