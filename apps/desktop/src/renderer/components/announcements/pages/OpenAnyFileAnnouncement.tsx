import { FileText } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import word from "./assets/files-word.webp";
import sheet from "./assets/files-sheet.webp";
import diagram from "./assets/files-diagram.webp";

/** Native previews for Word docs, spreadsheets, decks and diagrams. */
export default function OpenAnyFileAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <FileText size={17} weight="fill" />, name: "Files" }}
      headline="Docs, sheets and decks open in ADE."
      sentence="Word, Excel, PowerPoint and diagrams open in Files the way they look."
      action={{ tipId: "files", label: "Open Files" }}
      media={{
        kind: "images",
        width: 1560,
        height: 1050,
        images: [
          { src: word, alt: "A Word launch plan open in Files, with headings, a list and a table" },
          { src: sheet, alt: "A spreadsheet of weekly metrics open in Files" },
          { src: diagram, alt: "A Mermaid checkout flow drawn as a diagram in Files" },
        ],
      }}
    />
  );
}
