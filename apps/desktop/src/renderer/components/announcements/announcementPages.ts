import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * "What's new" pages: free-form announcements the owner writes as features
 * land, shown inside a project in one large modal (`AnnouncementsHost`).
 *
 * A page is any React component under `pages/`. Nothing about its layout is
 * fixed: video, an interactive demo, buttons that open a page or start a
 * tour step. The modal adds only the frame (close, "1 of 3", Back/Next).
 *
 * Showing rules (`announcementSeen.ts`):
 * - each page shows once per computer, keyed by `id` + `revision`;
 * - a new entry here shows on every computer that has not seen it;
 * - bump `revision` to show an edited page again (a typo fix that keeps the
 *   revision does not re-show it);
 * - removing an entry stops it from ever showing.
 *
 * Order here is display order when several are due. Pages load lazily, so
 * an entry costs nothing until it is shown.
 */

export type AnnouncementPageProps = {
  /** Close the whole "What's new" modal (a "Try it" button calls this before navigating). */
  close: () => void;
};

export type AnnouncementPageDef = {
  /** Stable id; never reuse one for a different page. */
  id: string;
  /** Bump to show the page again on computers that saw an earlier revision. */
  revision: number;
  /** Names the page for assistive tech and the Help menu list. */
  title: string;
  Page: LazyExoticComponent<ComponentType<AnnouncementPageProps>>;
};

export const ANNOUNCEMENT_PAGES: readonly AnnouncementPageDef[] = [
  {
    id: "ade-tips",
    revision: 1,
    title: "Meet ADE Tips",
    Page: lazy(() => import("./pages/AdeTipsAnnouncement")),
  },
];
