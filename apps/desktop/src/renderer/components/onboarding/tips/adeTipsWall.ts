import type { AdeTipGroupId } from "../../../onboarding/adeTips";
import automationsShot from "./assets/automations.webp";
import awakeShot from "./assets/awake.webp";
import commentsShot from "./assets/comments.webp";
import ctoShot from "./assets/cto.webp";
import filesShot from "./assets/files.webp";
import gridShot from "./assets/grid.webp";
import historyShot from "./assets/history.webp";
import importShot from "./assets/import.webp";
import integrationsShot from "./assets/integrations.webp";
import lanesShot from "./assets/lanes.webp";
import machinesShot from "./assets/machines.webp";
import mcpShot from "./assets/mcp.webp";
import proofShot from "./assets/proof.webp";
import prsShot from "./assets/prs.webp";
import secretsShot from "./assets/secrets.webp";
import themesShot from "./assets/themes.webp";
import widgetsShot from "./assets/widgets.webp";

/**
 * How each ADE Tips group is laid out as a wall: the group's own tile first
 * (2×1), then its tips in this order and size. A `screen` tile (2×2) carries
 * a screenshot of the real app; `wide` is 2×1; `small` is 1×1.
 *
 * The sizes are chosen so every group packs with no holes in both of the
 * dialog's grids: four columns (cells add up to a multiple of four and the
 * order fills each row) and two (an even number of small tiles). Change a
 * size, recount.
 *
 * Screenshots are the real app with mock data: the landing page's wall
 * (`apps/web/public/images/home/wall`) plus a few taken from the browser
 * preview. Vite hashes them; tiles load them lazily, only for the group on
 * screen.
 */

export type TipTileSize = "screen" | "wide" | "small";

export const ADE_TIPS_WALL: Record<AdeTipGroupId, readonly { id: string; size: TipTileSize }[]> = {
  agents: [
    { id: "import-chats", size: "screen" },
    { id: "at-menu", size: "wide" },
    { id: "chat-tools", size: "wide" },
    { id: "comments", size: "screen" },
    { id: "handoff", size: "small" },
    { id: "rewind", size: "small" },
    { id: "scenes", size: "small" },
    { id: "voice", size: "small" },
    { id: "cli-chats", size: "wide" },
  ],
  brain: [
    { id: "cto", size: "screen" },
    { id: "automations", size: "screen" },
    { id: "scheduled-sends", size: "wide" },
  ],
  machines: [
    { id: "connect-machine", size: "screen" },
    { id: "keep-awake", size: "screen" },
    { id: "phone", size: "wide" },
    { id: "web-app", size: "wide" },
    { id: "headless", size: "small" },
    { id: "notifications", size: "small" },
  ],
  integrations: [
    { id: "issues", size: "screen" },
    { id: "mcp-once", size: "screen" },
    { id: "cloud-agents", size: "small" },
    { id: "ade-mcp", size: "small" },
  ],
  git: [
    { id: "lanes", size: "screen" },
    { id: "prs", size: "screen" },
    { id: "history", size: "screen" },
    { id: "files", size: "screen" },
    { id: "pr-watch", size: "wide" },
    { id: "stacked-prs", size: "wide" },
    { id: "deep-links", size: "wide" },
  ],
  yours: [
    { id: "home-widgets", size: "screen" },
    { id: "themes", size: "screen" },
    { id: "grid-view", size: "screen" },
    { id: "music", size: "wide" },
  ],
  safety: [
    { id: "proof", size: "screen" },
    { id: "secrets", size: "screen" },
    { id: "private-desktop", size: "wide" },
  ],
};

export type TipShot = { src: string; alt: string };

/** The screenshot on a `screen` tile. */
export const ADE_TIP_SHOTS: Readonly<Record<string, TipShot>> = {
  "import-chats": { src: importShot, alt: "The import window: past Claude, Codex and Cursor chats on this computer" },
  comments: { src: commentsShot, alt: "A comment on a line of an agent's reply, set to send with the next message" },
  cto: { src: ctoShot, alt: "The CTO introducing itself in its chat" },
  automations: { src: automationsShot, alt: "The automation builder: an issue opens a lane and runs an agent" },
  "connect-machine": { src: machinesShot, alt: "The Connections panel listing connected, available and offline computers" },
  "keep-awake": { src: awakeShot, alt: "The keep awake setting: never, while away, or with the lid closed" },
  issues: { src: integrationsShot, alt: "Settings, Integrations: GitHub connected, with Linear and Jira beside it" },
  "mcp-once": { src: mcpShot, alt: "Settings, MCP servers found on this computer, ready to import" },
  lanes: { src: lanesShot, alt: "A lane: its branch, its commit ahead of main, and the chat that made it" },
  prs: { src: prsShot, alt: "A pull request with its description, branch and checks" },
  history: { src: historyShot, alt: "The history graph across lanes, with a commit selected" },
  files: { src: filesShot, alt: "The file editor on a lane, beside the project's files" },
  "home-widgets": { src: widgetsShot, alt: "The home page: projects, pull requests, weather and contributions" },
  themes: { src: themesShot, alt: "Appearance settings: the theme gallery and a live preview" },
  "grid-view": { src: gridShot, alt: "Two chats side by side in the grid view" },
  proof: { src: proofShot, alt: "An agent's reply with the screenshot it filed as proof" },
  secrets: { src: secretsShot, alt: "Settings, Secrets: three encrypted keys saved for this project" },
};
