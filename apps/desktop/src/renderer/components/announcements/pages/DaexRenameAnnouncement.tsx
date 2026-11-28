import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import icon from "./assets/daex-rename.webp";
import { BRAND } from "../../../../shared/brand";
import { publicAssetUrl } from "../../../lib/publicAssetUrl";

/** The product's new name, once: only the name changed. */
export default function DaexRenameAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{
        icon: <img src={publicAssetUrl("welcome/ade-icon.webp")} alt="" width={22} height={22} draggable={false} />,
        name: BRAND.INTRO_NAME,
      }}
      headline={`${BRAND.FORMER_NAME} is now ${BRAND.NAME}.`}
      sentence={`Only the name changed. Your projects, chats and settings stay as they are, the ${BRAND.LEGACY_CLI} command still works, and ${BRAND.LEGACY_DOMAIN} links still open.`}
      media={{
        kind: "images",
        width: 1600,
        height: 876,
        images: [{ src: icon, alt: `The ${BRAND.NAME} app icon: a white æ on violet` }],
      }}
    />
  );
}
