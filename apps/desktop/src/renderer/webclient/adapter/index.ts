import type { ProjectInfo } from "../../../shared/types";
import { isWebClientMode } from "../../lib/webClientMode";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type { AdeSyncClient } from "../sync";
import { BrowserAccountClient } from "../account/client";
import { createAccountNamespace } from "./account";
import { createAgentChatNamespace } from "./agentChat";
import { createAnalyticsNamespace } from "./analytics";
import { createAttentionNamespace } from "./attention";
import { createAppNamespace, webUpdateMethods } from "./app";
import { createFilesNamespace } from "./files";
import { createGitNamespaces } from "./git";
import { CommandCaller } from "./infra/commandCaller";
import { EventBus } from "./infra/eventBus";
import { createInvalidationScheduler } from "./infra/invalidation";
import { ALL_INVALIDATION_DOMAINS, type InvalidationDomain } from "./infra/invalidation";
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
  replaceProject(project: ProjectInfo, projectId: string): void;
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
  automations: false,
  // The notch is a native macOS helper supervised by the desktop main process.
  // On web the namespace never registers, so `withFallbackProxy` resolves it to
  // null; naming it here lets settings hide the controls instead of showing
  // switches that silently do nothing.
  attentionNotch: false,
} as const;

export type WebHiddenCapability = keyof typeof WEB_HIDDEN_CAPABILITIES;

/** Whether a capability is unavailable because this window is the web client. */
export function isWebHiddenCapability(capability: WebHiddenCapability): boolean {
  return isWebClientMode() && WEB_HIDDEN_CAPABILITIES[capability] === false;
}

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
    attention: createAttentionNamespace(infra, accountClient),
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
    updateGetPreferences: webUpdateMethods.updateGetPreferences,
    updateSetPreferences: webUpdateMethods.updateSetPreferences,
    updateGetInstallImpact: webUpdateMethods.updateGetInstallImpact,
    updateQuitAndInstall: webUpdateMethods.updateQuitAndInstall,
    updateCancelAutoApply: webUpdateMethods.updateCancelAutoApply,
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
    replaceProject(project: ProjectInfo, projectId: string): void {
      events.emit("projectBoundary", { projectId });
      terminalRegistry.clear();
      state.bindProject(project, projectId);
      commands.invalidateCache();
      events.emit("projectChanged", project);
      events.emit("projectBindingChanged", null);
      events.emit("invalidation", {
        tables: [],
        domains: [...ALL_INVALIDATION_DOMAINS],
        at: new Date().toISOString(),
      });
    },
    dispose(): void {
      for (const dispose of disposers.splice(0)) dispose();
      events.clear();
    },
  };
}
