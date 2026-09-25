import type { AgentChatEventEnvelope } from "./chat";
import type { ExternalSessionMessage, ExternalSessionProvider } from "./externalSessions";

export type ExternalSessionDetailArgs = {
  provider: ExternalSessionProvider;
  sessionId: string;
  /** Paging cursor from `olderCursor`; loads the page just before it. */
  before?: string | null;
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
  /**
   * The conversation as ADE chat events, oldest to newest — the same events an
   * import writes, so the preview shows what the user will get. Optional: older
   * hosts only send `messages`.
   */
  events?: AgentChatEventEnvelope[] | null;
  /** True when older events exist before `events[0]`. */
  hasOlder?: boolean;
  /** Pass as `before` to load the previous page. */
  olderCursor?: string | null;
};

export type ExternalSessionDetailWatchArgs = ExternalSessionDetailArgs & {
  watchId: string;
};

export type ExternalSessionDetailUpdatedEvent = {
  watchId: string;
  detail: ExternalSessionDetail;
};
