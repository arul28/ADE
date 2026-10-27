import { GithubLogo, Ticket } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import { JiraMark } from "../../lanes/jiraBrand";
import { LINEAR_BRAND, LinearMark } from "../../lanes/linearBrand";
import browse from "./assets/issues-browse.webp";
import create from "./assets/issues-new.webp";

/** Jira, Linear and GitHub issues in one place. */
export default function IssuesAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Ticket size={17} weight="fill" />, name: "Issues" }}
      headline="Track Jira, Linear and GitHub issues in ADE."
      sentence="Read, comment, change status and file new issues without leaving ADE. Start a lane and an agent straight from an issue."
      marks={[
        { icon: <JiraMark size={13} />, label: "Jira" },
        { icon: <span style={{ color: LINEAR_BRAND.primaryBright, display: "inline-flex" }}><LinearMark size={13} /></span>, label: "Linear" },
        { icon: <GithubLogo size={14} weight="fill" />, label: "GitHub" },
      ]}
      media={{
        kind: "images",
        width: 1560,
        height: 1005,
        images: [
          { src: create, alt: "One New issue form with Linear, GitHub and Jira tabs" },
          { src: browse, alt: "Jira issues in ADE: a list of issues and one issue's details, with Launch agent" }
        ],
      }}
    />
  );
}
