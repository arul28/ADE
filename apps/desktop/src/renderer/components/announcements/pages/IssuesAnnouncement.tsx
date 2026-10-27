import { GithubLogo, Ticket } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import { JiraMark } from "../../lanes/jiraBrand";
import { LINEAR_BRAND, LinearMark } from "../../lanes/linearBrand";
import attachVideo from "./assets/issues-attach.mp4";
import attachStill from "./assets/issues-attach-still.webp";
import browse from "./assets/issues-browse.webp";
import create from "./assets/issues-new.webp";

/** Jira, Linear and GitHub issues in one place, and attached to a chat. */
export default function IssuesAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Ticket size={17} weight="fill" />, name: "Issues" }}
      headline="Track Jira, Linear and GitHub issues in ADE."
      sentence="Attach an issue to a chat and the agent starts with all of it. Read, comment and file new issues without leaving ADE."
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
          { src: attachStill, video: attachVideo, alt: "Attaching a GitHub issue to a chat from the composer's menu, then opening the issue" },
          { src: create, alt: "One New issue form with Linear, GitHub and Jira tabs" },
          { src: browse, alt: "Jira issues in ADE: a list of issues and one issue's details, with Launch agent" },
        ],
      }}
    />
  );
}
