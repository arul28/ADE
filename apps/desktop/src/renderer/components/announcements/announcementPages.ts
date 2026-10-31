import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * The "What's new" catalogue: one entry per feature page. Add an entry when a
 * feature lands, remove it whenever. Nothing here is tied to a release; the
 * pages in the catalogue when a version is cut ship with it.
 *
 * Who sees what (`announcementSeen.ts`):
 * - a page shows by itself for 45 days after its `added` date, then only in
 *   Help › What's new;
 * - a computer never shows the same page twice, wherever it showed first;
 * - at most 3 pages at a time, newest first: after an update (with the
 *   release notes as an "And more" page) or, at most once a day, inside a
 *   project. Pages left over show on a later day.
 *
 * Pages load lazily, so an entry costs nothing until it is shown.
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
};

export const ANNOUNCEMENT_PAGES: readonly AnnouncementPageDef[] = [
  {
    id: "performance-vs-t3-code",
    added: "2026-10-31",
    title: "Faster than T3 Code",
    Page: lazy(() => import("./pages/PerformanceAnnouncement")),
  },
  {
    id: "manage-provider-accounts",
    added: "2026-10-28",
    title: "Manage your accounts in detail",
    Page: lazy(() => import("./pages/ProviderAccountsAnnouncement")),
  },
  {
    id: "side-chats",
    added: "2026-10-27",
    title: "Side chats",
    Page: lazy(() => import("./pages/SideChatsAnnouncement")),
  },
  {
    id: "issues",
    added: "2026-10-27",
    title: "Jira, Linear and GitHub issues",
    Page: lazy(() => import("./pages/IssuesAnnouncement")),
  },
  {
    id: "music",
    added: "2026-10-27",
    title: "Apple Music and Spotify",
    Page: lazy(() => import("./pages/MusicAnnouncement")),
  },
  {
    id: "open-any-file",
    added: "2026-10-27",
    title: "Open any file",
    Page: lazy(() => import("./pages/OpenAnyFileAnnouncement")),
  },
  {
    id: "chats-every-machine",
    added: "2026-10-27",
    title: "Every machine's chats",
    Page: lazy(() => import("./pages/ChatsEveryMachineAnnouncement")),
  },
  {
    id: "phone-pull-requests",
    added: "2026-10-27",
    title: "Pull requests on your phone",
    Page: lazy(() => import("./pages/PhonePullRequestsAnnouncement")),
  },
  {
    id: "wallpapers",
    added: "2026-10-27",
    title: "Wallpapers for your screen",
    Page: lazy(() => import("./pages/WallpapersAnnouncement")),
  },
  {
    id: "iphone-duo",
    added: "2026-10-21",
    title: "iPhone Duo in the simulator",
    Page: lazy(() => import("./pages/IphoneDuoAnnouncement")),
  },
  {
    id: "phone-simulator-stream",
    added: "2026-10-21",
    title: "The simulator on your iPhone",
    Page: lazy(() => import("./pages/PhoneSimulatorAnnouncement")),
  },
  {
    id: "windows-desktop",
    added: "2026-10-21",
    title: "Windows desktop from any machine",
    Page: lazy(() => import("./pages/WindowsDesktopAnnouncement")),
  },
];
