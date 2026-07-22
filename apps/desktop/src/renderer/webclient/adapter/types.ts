import type {
  AppNavigationRequest,
  FileChangeEvent,
  FilesGitStatusEvent,
  GitHubStatus,
  LaneDeleteEvent,
  LaneLifecycleEvent,
  OpenProjectBinding,
  PrEventPayload,
  ProjectInfo,
  PtyDataEvent,
  PtyExitEvent,
  RebaseEventPayload,
  SyncStatusEventPayload,
  TerminalSessionChangedEvent,
} from "../../../shared/types";
import type { SyncChatEventPayload } from "../../../shared/types/sync";
import type { AdeSyncClient } from "../sync";
import type { CommandCaller } from "./infra/commandCaller";
import type { EventBus } from "./infra/eventBus";
import type { InvalidationEvent } from "./infra/invalidation";
import type { LocalState } from "./infra/localState";
import type { AdapterProjectState } from "./infra/projectState";
import type { TerminalRegistry } from "./infra/registries";

export type AdapterEvents = {
  projectBoundary: { projectId: string };
  projectChanged: ProjectInfo | null;
  projectBindingChanged: OpenProjectBinding | null;
  projectMissing: { rootPath: string };
  navigate: AppNavigationRequest;
  syncStatus: SyncStatusEventPayload;
  invalidation: InvalidationEvent;
  lanesInvalidated: InvalidationEvent;
  lanesLifecycle: LaneLifecycleEvent;
  lanesDelete: LaneDeleteEvent;
  sessionsInvalidated: InvalidationEvent;
  sessionsChanged: TerminalSessionChangedEvent;
  chatsInvalidated: InvalidationEvent;
  agentChatEvent: SyncChatEventPayload;
  ptyData: PtyDataEvent;
  ptyExit: PtyExitEvent;
  prsInvalidated: InvalidationEvent;
  prsEvent: PrEventPayload;
  filesInvalidated: InvalidationEvent;
  filesChanged: FileChangeEvent;
  filesGitStatus: FilesGitStatusEvent;
  githubInvalidated: InvalidationEvent;
  githubStatusChanged: GitHubStatus;
  rebaseInvalidated: InvalidationEvent;
  rebaseEvent: RebaseEventPayload;
};

export type AdapterInfra = {
  client: AdeSyncClient;
  commands: CommandCaller;
  state: AdapterProjectState;
  events: EventBus<AdapterEvents>;
  localState: LocalState;
  terminalRegistry: TerminalRegistry;
  addDispose(dispose: () => void): void;
};

export type AdeNamespace<TName extends keyof Window["ade"]> = Partial<Window["ade"][TName]>;
