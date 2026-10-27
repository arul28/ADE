/** Replaced at package time by scripts/bundle-release-notes.mjs when this version has a changelog page. */
export type BundledReleaseNotesEntry = { version: string; markdown: string };

export const bundledReleaseNotes: {
  version: string | null;
  markdown: string | null;
  /** This version and the ones before it, newest first. */
  history: BundledReleaseNotesEntry[];
} = {
  version: null,
  markdown: null,
  history: [],
};
