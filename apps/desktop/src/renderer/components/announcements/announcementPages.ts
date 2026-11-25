import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * The "What's new" catalogue: one entry per feature page. Add an entry when a
 * feature lands, remove it whenever. Nothing here is tied to a release; the
 * pages in the catalogue when a version is cut ship with it.
 *
 * Who sees what (`announcementSeen.ts`):
 * - a page shows by itself for 21 days after its `added` date, then only in
 *   Help › What's new;
 * - a computer never shows the same page twice, wherever it showed first;
 * - at most 2 pages at a time, newest first: after an update (with the
 *   release notes as an "And more" page) or, at most once a week, inside a
 *   project, within the shared unasked budget (`unaskedBudget.ts`). Pages
 *   left over show on a later week.
 *
 * Pages load lazily, so an entry costs nothing until it is shown. A showing
 * that opens by itself waits for its first page's code (`load`): the page's
 * entrance is timed from when it mounts, and after an update it also waits
 * for the logo to land, so a page still loading left the window empty.
 */

export type AnnouncementPageProps = {
  /** Close the whole "What's new" modal (a button that goes somewhere calls this first). */
  close: () => void;
};

export type AnnouncementPageDef = {
  /** Stable id; never reuse one for a different page. */
  id: string;
  /** The day the page was added (YYYY-MM-DD), not the day its feature merged. */
  added: string;
  /** Names the page for assistive tech and the page dots. */
  title: string;
  Page: LazyExoticComponent<ComponentType<AnnouncementPageProps>>;
  /** Fetches the page's code ahead of showing it; `Page` then renders without waiting. */
  load: () => Promise<unknown>;
};

type PageModule = { default: ComponentType<AnnouncementPageProps> };

/** One fetch shared by `load` and `Page`, so a page loaded ahead is not fetched again. */
function lazyPage(importPage: () => Promise<PageModule>): Pick<AnnouncementPageDef, "Page" | "load"> {
  let loading: Promise<PageModule> | null = null;
  const load = () => {
    // A failed fetch is not kept: the next showing tries again.
    loading ??= importPage().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
  return { Page: lazy(load), load };
}

export const ANNOUNCEMENT_PAGES: readonly AnnouncementPageDef[] = [
  {
    id: "ade-cloud",
    added: "2026-11-18",
    title: "ADE Cloud",
    ...lazyPage(() => import("./pages/AdeCloudAnnouncement")),
  },
  {
    id: "passwords",
    added: "2026-11-18",
    title: "Passwords & Secrets",
    ...lazyPage(() => import("./pages/PasswordsAnnouncement")),
  },
  {
    id: "cto-v2",
    added: "2026-11-18",
    title: "A CTO that remembers",
    ...lazyPage(() => import("./pages/CtoAnnouncement")),
  },
  {
    id: "subagents-any-model",
    added: "2026-11-04",
    title: "Subagents on any model",
    ...lazyPage(() => import("./pages/SubagentsAnnouncement")),
  },
  {
    id: "integrations-page",
    added: "2026-11-04",
    title: "Every integration on one page",
    ...lazyPage(() => import("./pages/IntegrationsAnnouncement")),
  },
  {
    id: "custom-harnesses",
    added: "2026-11-04",
    title: "Any harness on your plan",
    ...lazyPage(() => import("./pages/CustomHarnessAnnouncement")),
  },
  {
    id: "media-comments",
    added: "2026-11-04",
    title: "Comments on screenshots and videos",
    ...lazyPage(() => import("./pages/MediaCommentsAnnouncement")),
  },
  {
    id: "ade-beta",
    added: "2026-11-04",
    title: "ADE Beta",
    ...lazyPage(() => import("./pages/BetaAnnouncement")),
  },
  {
    id: "manage-provider-accounts",
    added: "2026-10-28",
    title: "Manage your accounts in detail",
    ...lazyPage(() => import("./pages/ProviderAccountsAnnouncement")),
  },
  {
    id: "side-chats",
    added: "2026-10-27",
    title: "Side chats",
    ...lazyPage(() => import("./pages/SideChatsAnnouncement")),
  },
  {
    id: "issues",
    added: "2026-10-27",
    title: "Jira, Linear and GitHub issues",
    ...lazyPage(() => import("./pages/IssuesAnnouncement")),
  },
  {
    id: "music",
    added: "2026-10-27",
    title: "Apple Music and Spotify",
    ...lazyPage(() => import("./pages/MusicAnnouncement")),
  },
  {
    id: "open-any-file",
    added: "2026-10-27",
    title: "Open any file",
    ...lazyPage(() => import("./pages/OpenAnyFileAnnouncement")),
  },
  {
    id: "chats-every-machine",
    added: "2026-10-27",
    title: "Every machine's chats",
    ...lazyPage(() => import("./pages/ChatsEveryMachineAnnouncement")),
  },
  {
    id: "phone-pull-requests",
    added: "2026-10-27",
    title: "Pull requests on your phone",
    ...lazyPage(() => import("./pages/PhonePullRequestsAnnouncement")),
  },
  {
    id: "wallpapers",
    added: "2026-10-27",
    title: "Wallpapers for your screen",
    ...lazyPage(() => import("./pages/WallpapersAnnouncement")),
  },
  {
    id: "iphone-duo",
    added: "2026-10-21",
    title: "iPhone Duo in the simulator",
    ...lazyPage(() => import("./pages/IphoneDuoAnnouncement")),
  },
  {
    id: "phone-simulator-stream",
    added: "2026-10-21",
    title: "The simulator on your iPhone",
    ...lazyPage(() => import("./pages/PhoneSimulatorAnnouncement")),
  },
  {
    id: "windows-desktop",
    added: "2026-10-21",
    title: "Windows and Linux for agents",
    ...lazyPage(() => import("./pages/WindowsDesktopAnnouncement")),
  },
];
