/**
 * The CTO's account copy: what a new home machine restores the CTO from, so a
 * move or a rebuilt cloud computer keeps its memory and its recent
 * conversation even when the old machine is asleep or gone.
 *
 * One account vault item per repository (scope `repo:<origin>`, kind
 * `cto_copy`, key `cto`), written by the home machine's brain after each CTO
 * turn (`main/services/cto/ctoAccountCopyService.ts`). The vault seals it at
 * rest; it is platform encryption, as for Saved Chats.
 *
 * Only the home machine writes it. The account's CTO home record
 * (`cto.homeMachine`, `shared/ctoHomeMachine.ts`) says which machine that is,
 * and a machine that is not the home neither writes the copy nor runs CTO
 * turns.
 */

export const CTO_ACCOUNT_COPY_VAULT_KIND = "cto_copy";
export const CTO_ACCOUNT_COPY_VAULT_KEY = "cto";
/** The relay's ceiling for the kind is 48,000 chars; the encoder stays under this. */
export const CTO_ACCOUNT_COPY_MAX_CHARS = 46_000;
/** The conversation tail kept in the copy, newest last. */
export const CTO_ACCOUNT_COPY_TAIL_MAX_CHARS = 24_000;

/** One change the person undid, as the CTO's undone list keeps it. */
export type CtoAccountCopyUndone = { area: string; op: string; text: string; at: string };

/** One CTO routine, as a new home machine re-creates it. */
export type CtoAccountCopyRoutine = {
  title: string;
  prompt: string;
  cron: string;
  timeZone?: string;
  reason?: string;
  paused?: boolean;
};

export type CtoAccountCopy = {
  v: 1;
  /** The sync device id of the machine that wrote it: the CTO's home then. */
  ownerDeviceId: string;
  ownerName: string;
  savedAt: string;
  /** The identity fields that make sense on any machine (no account ids). */
  identity: Record<string, unknown>;
  projectNotes: string;
  userNotes: string;
  /** `.ade/cto/open-work.json` as written, or null when it has none. */
  openWork: string | null;
  /** `.ade/cto/RULES.md` as written. Missing in copies from older builds. */
  rules?: string;
  /** Each skill's whole SKILL.md, by name. Missing in copies from older builds, or when they did not fit. */
  skills?: Array<{ name: string; text: string }>;
  /**
   * What the person undid (`.ade/cto/learning/undone.json`), so the CTO at a
   * new home does not make those changes again. Missing in copies from older builds.
   */
  undone?: CtoAccountCopyUndone[];
  routines: CtoAccountCopyRoutine[];
  /** The last turns, as the CTO's own conversation tail renders them. */
  tail: string;
  /**
   * The story so far: the helper's summary of the conversation older than the
   * tail (`main/services/cto/ctoStory.ts`). Missing in copies from older builds.
   */
  story?: CtoAccountCopyStory | null;
};

export type CtoAccountCopyStory = {
  summary: string;
  startsAt: string;
  coveredThrough: string;
};

/** What the CTO page shows about the copy. */
export type CtoAccountCopyStatus = {
  /** False when this machine can't reach the account vault (signed out, no origin). */
  available: boolean;
  savedAt: string | null;
  ownerName: string | null;
  ownerIsThisMachine: boolean;
};

export type CtoAdoptAccountCopyArgs = {
  /** The account's new home record, so this machine's settings agree before its next sync. */
  home?: unknown;
};

export type CtoAdoptAccountCopyResult = {
  /** True when this machine took the CTO's memory and turns from the copy. */
  restored: boolean;
  /** The machine the copy came from, when it was restored. */
  fromName: string | null;
  savedAt: string | null;
};
