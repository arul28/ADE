/**
 * Project notes: short facts earlier agents learned about working on one
 * project in ADE (how to launch its app, which port its dev server takes, an
 * ADE quirk here). Stored in the project's database, replicated to every
 * machine with the project, and injected into each new agent session.
 *
 * `project` notes hold on any machine with the project; `machine` notes hold
 * only on the machine that saved them.
 */
export type ProjectNoteScope = "project" | "machine";

export const PROJECT_NOTE_SCOPES: readonly ProjectNoteScope[] = ["project", "machine"];

/**
 * The hard caps, enforced by the service on every write. One place, so the
 * refusal messages, the CLI help and the prompt all agree.
 */
export const PROJECT_NOTES_LIMITS = {
  /** One note: a single line, at most this many characters. */
  maxNoteChars: 200,
  /** A section label: `iOS`, `Electron`, `Dev server`… */
  maxSectionChars: 32,
  /** Notes one agent sees in one section (project + its machine). */
  maxNotesPerSection: 8,
  /** The whole rendered block one agent receives, rule text included, in UTF-8 bytes. */
  maxRenderedBytes: 3072,
} as const;

export type ProjectNote = {
  id: string;
  scope: ProjectNoteScope;
  /** The account machine key a `machine` note holds on; null for `project`. */
  machineId: string | null;
  section: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** The chat or CLI session that last wrote it, when there was one. */
  updatedBy: string | null;
};

export type ProjectNotesListArgs = {
  section?: string | null;
  scope?: ProjectNoteScope | null;
};

export type ProjectNotesListResult = {
  /** Project notes plus this machine's notes, grouped by section then age. */
  notes: ProjectNote[];
  /** This machine's account key, or null when its identity cannot be read. */
  machineId: string | null;
  /** Size of the block an agent on this machine receives now. */
  renderedBytes: number;
  limits: typeof PROJECT_NOTES_LIMITS;
};

export type ProjectNotesAddArgs = {
  section: string;
  body: string;
  scope?: ProjectNoteScope | null;
  sessionId?: string | null;
};

export type ProjectNotesEditArgs = {
  id: string;
  section?: string | null;
  body?: string | null;
  scope?: ProjectNoteScope | null;
  sessionId?: string | null;
};

export type ProjectNotesRemoveArgs = {
  id: string;
};
