import type { ProjectInfo } from "../../../shared/types";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type { AdeSyncClient } from "../sync";
import { BrowserAccountClient } from "../account/client";
import { createAccountNamespace } from "./account";
import { createAgentChatNamespace } from "./agentChat";
import { createAnalyticsNamespace } from "./analytics";
import { createAppNamespace, webUpdateMethods } from "./app";
import { createFilesNamespace } from "./files";
import { createGitNamespaces } from "./git";
import { CommandCaller } from "./infra/commandCaller";
import { EventBus } from "./infra/eventBus";
import { createInvalidationScheduler } from "./infra/invalidation";
import type { InvalidationDomain } from "./infra/invalidation";
import { createLocalState } from "./infra/localState";
import { createProjectState } from "./infra/projectState";
import { withFallbackProxy } from "./infra/proxy";
import { TerminalRegistry } from "./infra/registries";
import { createLanesNamespace } from "./lanes";
import { createMiscNamespaces } from "./misc";
import { createProjectNamespace } from "./project";
import { createPrsNamespace } from "./prs";
import { createPersonalChatsNamespace } from "./personalChats";
import { createRemoteRuntimeNamespace } from "./remoteRuntime";
import { createSessionsPtyNamespaces } from "./sessionsPty";
import type { AdapterEvents, AdapterInfra } from "./types";

export type AdeWebAdapter = {
  ade: Window["ade"];
  bindProject(project: ProjectInfo | null, projectId?: string | null): void;
  dispose(): void;
};

export const WEB_HIDDEN_CAPABILITIES = {
  revealInFinder: false,
  externalEditor: false,
  updater: false,
  builtInBrowser: false,
  appControl: false,
  iosSimulator: false,
  computerUse: false,
  nativeWindowControls: false,
  nativeDirectoryPicker: false,
  localPathOpen: false,
  cursorCloud: false,
  transcription: false,
  processes: false,
  automations: false,
} as const;

const DOMAIN_EVENTS = {
  lanes: "lanesInvalidated",
  sessions: "sessionsInvalidated",
  chats: "chatsInvalidated",
  prs: "prsInvalidated",
  files: "filesInvalidated",
  github: "githubInvalidated",
  rebase: "rebaseInvalidated",
} as const satisfies Record<InvalidationDomain,
  | "lanesInvalidated"
  | "sessionsInvalidated"
  | "chatsInvalidated"
  | "prsInvalidated"
  | "filesInvalidated"
  | "githubInvalidated"
  | "rebaseInvalidated"
>;

export function createAdeWebAdapter(
  client: AdeSyncClient,
  initialCatalog?: SyncMobileProjectSummary[],
  providedAccountClient?: BrowserAccountClient,
): AdeWebAdapter {
  const disposers: Array<() => void> = [];
  const addDispose = (dispose: () => void) => disposers.push(dispose);
  const state = createProjectState(client);
  const events = new EventBus<AdapterEvents>();
  const localState = createLocalState(() => state.getProjectId());
  const commands = new CommandCaller(client, state);
  const terminalRegistry = new TerminalRegistry();
  const infra: AdapterInfra = {
    client,
    commands,
    state,
    events,
    localState,
    terminalRegistry,
    addDispose,
  };

  addDispose(state.dispose);
  if (initialCatalog) {
    state.updateCatalog(initialCatalog);
  } else {
    void client.getProjectCatalog().then((catalog) => state.updateCatalog(catalog.projects)).catch(() => undefined);
  }
  addDispose(
    createInvalidationScheduler(
      (listener) => client.onTablesChanged(listener),
      events as never
    )
  );
  addDispose(
    events.on("invalidation", (event) => {
      for (const domain of event.domains) {
        events.emit(DOMAIN_EVENTS[domain], event);
      }
    })
  );

  const { sessions, pty, terminal } = createSessionsPtyNamespaces(infra);
  const { git, diff, conflicts } = createGitNamespaces(infra);
  const misc = createMiscNamespaces(infra);
  const accountClient = providedAccountClient ?? new BrowserAccountClient();

  const surface = {
    app: createAppNamespace(infra),
    account: createAccountNamespace(accountClient),
    analytics: createAnalyticsNamespace(infra),
    project: createProjectNamespace(infra),
    remoteRuntime: createRemoteRuntimeNamespace(infra),
    lanes: createLanesNamespace(infra),
    sessions,
    agentChat: createAgentChatNamespace(infra),
    personalChats: createPersonalChatsNamespace(infra),
    pty,
    terminal,
    diff,
    files: createFilesNamespace(infra),
    git,
    conflicts,
    prs: createPrsNamespace(infra),
    sync: misc.sync,
    keybindings: misc.keybindings,
    projectSecrets: misc.projectSecrets,
    ai: misc.ai,
    transcription: misc.transcription,
    modelPicker: misc.modelPicker,
    agentTools: misc.agentTools,
    adeCli: misc.adeCli,
    devTools: misc.devTools,
    onboarding: misc.onboarding,
    github: misc.github,
    rebase: misc.rebase,
    history: misc.history,
    layout: misc.layout,
    tilingTree: misc.tilingTree,
    graphState: misc.graphState,
    processes: misc.processes,
    tests: misc.tests,
    projectConfig: misc.projectConfig,
    cto: misc.cto,
    orchestration: misc.orchestration,
    computerUse: misc.computerUse,
    iosSimulator: misc.iosSimulator,
    appControl: misc.appControl,
    builtInBrowser: misc.builtInBrowser,
    usage: misc.usage,
    review: misc.review,
    automations: misc.automations,
    feedback: misc.feedback,
    updateCheckForUpdates: async () => undefined,
    updateGetState: webUpdateMethods.updateGetState,
    updateGetInstallImpact: webUpdateMethods.updateGetInstallImpact,
    updateQuitAndInstall: webUpdateMethods.updateQuitAndInstall,
    updateDismissInstalledNotice: async () => undefined,
    onUpdateEvent: () => () => {},
    perf: {
      getConfig: async () => ({
        active: false,
        runId: null,
        scenario: null,
        initialRoute: null,
        projectRoot: state.getProject()?.rootPath ?? null,
        allowClaude: false,
        modelOverride: null,
      }),
      recordEvent: async () => ({ ok: true }),
      scenarioComplete: async () => ({ ok: true }),
      finalize: async () => ({ ok: true }),
    },
  };

  return {
    ade: withFallbackProxy(surface as unknown as Window["ade"]),
    bindProject(project: ProjectInfo | null, projectId?: string | null): void {
      state.bindProject(project, projectId);
      events.emit("projectChanged", project);
      events.emit("projectBindingChanged", null);
    },
    dispose(): void {
      for (const dispose of disposers.splice(0)) dispose();
      events.clear();
    },
  };
}
