import { ChatCircleText, CheckCircle, DeviceMobile, Smiley } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import pr from "./assets/phone-pr.webp";
import comments from "./assets/phone-comments.webp";
import checks from "./assets/phone-checks.webp";

/** Pull requests in the iPhone app: reactions, comments, live checks. */
export default function PhonePullRequestsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <DeviceMobile size={17} weight="fill" />, name: "iPhone app" }}
      headline="Review pull requests from your phone."
      sentence="Read the PR, react, comment and watch checks finish, from the ADE app on your iPhone or iPad."
      marks={[
        { icon: <Smiley size={14} weight="fill" />, label: "Reactions" },
        { icon: <ChatCircleText size={14} weight="fill" />, label: "Comments" },
        { icon: <CheckCircle size={14} weight="fill" color="#3fb950" />, label: "Live checks" },
      ]}
      action={{ tipId: "phone", label: "Pair your iPhone" }}
      media={{
        kind: "phones",
        width: 699,
        height: 1017,
        images: [
          { src: comments, alt: "A pull request's comments on iPhone, with reactions" },
          { src: pr, alt: "A pull request on iPhone: summary, test plan and reactions" },
          { src: checks, alt: "A pull request on iPhone with one check failing" },
        ],
      }}
    />
  );
}
