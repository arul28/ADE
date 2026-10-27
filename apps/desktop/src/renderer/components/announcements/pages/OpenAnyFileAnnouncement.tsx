import { FileDoc, FilePpt, FileText, FileXls, FlowArrow } from "@phosphor-icons/react";
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
      headline="Open docs, sheets and decks in ADE."
      sentence="Word, Excel and PowerPoint files open in Files the way they look, and diagrams draw themselves. Click a file an agent mentions to open it."
      marks={[
        { icon: <FileDoc size={14} weight="fill" color="#4b8bf5" />, label: "Word" },
        { icon: <FileXls size={14} weight="fill" color="#22a06b" />, label: "Excel" },
        { icon: <FilePpt size={14} weight="fill" color="#e8743b" />, label: "PowerPoint" },
        { icon: <FlowArrow size={14} weight="bold" />, label: "Mermaid" },
      ]}
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
