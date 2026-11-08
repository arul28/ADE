import { PlugsConnected } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import home from "./assets/integrations-home.webp";
import mcp from "./assets/integrations-mcp.webp";

/** One Integrations page: the built-in integrations and the MCP catalogue. */
export default function IntegrationsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <PlugsConnected size={17} weight="fill" />, name: "Integrations" }}
      headline="All your integrations, one page."
      sentence="Connect GitHub, Linear and Jira, or add an MCP server in one click, in Settings › Integrations."
      action={{ tipId: "mcp-once", label: "Open Integrations" }}
      media={{
        kind: "images",
        width: 1600,
        height: 990,
        images: [
          { src: home, alt: "Built into ADE: GitHub, Linear and Jira, each with its own card" },
          { src: mcp, alt: "The MCP servers catalogue: Notion, Sentry, Supabase, Stripe, Cloudflare and dozens more, each one click to set up" },
        ],
      }}
    />
  );
}
