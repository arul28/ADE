import type { ExternalSessionMessage, ExternalSessionProvider } from "./externalSessions";

export type ExternalSessionDetailArgs = {
  provider: ExternalSessionProvider;
  sessionId: string;
};

export type ExternalSessionDetailMessage = ExternalSessionMessage;

export type ExternalSessionDetail = {
  provider: ExternalSessionProvider;
  id: string;
  cwd: string | null;
  title: string | null;
  model: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number | null;
  /** Oldest-to-newest tail parsed from the session file, not the list sample. */
  messages: ExternalSessionDetailMessage[];
  /** Absolute path of the watched session file, when one exists. */
  sourcePath: string | null;
  watchable: boolean;
};

export type ExternalSessionDetailWatchArgs = ExternalSessionDetailArgs & {
  watchId: string;
};

export type ExternalSessionDetailUpdatedEvent = {
  watchId: string;
  detail: ExternalSessionDetail;
};
