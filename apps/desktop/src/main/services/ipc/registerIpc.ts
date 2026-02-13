import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { IPC } from "../../../shared/ipc";
import type {
  ApplyConflictProposalArgs,
  BatchAssessmentResult,
  AttachLaneArgs,
  AppInfo,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunDetail,
  AutomationParseNaturalLanguageRequest,
  AutomationParseNaturalLanguageResult,
  AutomationValidateDraftRequest,
  AutomationValidateDraftResult,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
  AutomationSimulateRequest,
  AutomationSimulateResult,
  ConflictProposal,
  ConflictOverlap,
  ConflictStatus,
  CreateLaneArgs,
  CreateChildLaneArgs,
  DeleteLaneArgs,
  DockLayout,
  GraphPersistedState,
  FileChangeEvent,
  FileContent,
  FileTreeNode,
  FilesCreateDirectoryArgs,
  FilesCreateFileArgs,
  FilesDeleteArgs,
  FilesListTreeArgs,
  FilesListWorkspacesArgs,
  FilesQuickOpenArgs,
  FilesQuickOpenItem,
  FilesReadFileArgs,
  FilesRenameArgs,
  FilesSearchTextArgs,
  FilesSearchTextMatch,
  FilesWatchArgs,
  FilesWorkspace,
  FilesWriteTextArgs,
  GitActionResult,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCommitSummary,
  GitConflictState,
  GitGetCommitMessageArgs,
  GitListCommitFilesArgs,
  GitFileActionArgs,
  GitPushArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  GitHubStatus,
  CreatePrFromLaneArgs,
  LinkPrToLaneArgs,
  LandResult,
  PrCheck,
  PrReview,
  PrStatus,
  PrSummary,
  UpdatePrDescriptionArgs,
  LandPrArgs,
  LandStackArgs,
  GetLaneConflictStatusArgs,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  ExportConfigBundleResult,
  HostedArtifactResult,
  HostedBootstrapConfig,
  HostedGitHubAppStatus,
  HostedGitHubConnectStartResult,
  HostedGitHubDisconnectResult,
  HostedGitHubEventsResult,
  HostedJobStatusResult,
  HostedJobSubmissionArgs,
  HostedJobSubmissionResult,
  HostedMirrorDeleteResult,
  HostedMirrorSyncArgs,
  HostedMirrorSyncResult,
  HostedSignInArgs,
  HostedSignInResult,
  HostedStatus,
  AgentTool,
  KeybindingOverride,
  KeybindingsSnapshot,
  ImportBranchLaneArgs,
  CiScanResult,
  CiImportRequest,
  CiImportResult,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  LaneSummary,
  ListOperationsArgs,
  ListOverlapsArgs,
  ListLanesArgs,
  ListSessionsArgs,
  ListTestRunsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  OperationRecord,
  PackEvent,
  PackSummary,
  PackVersion,
  PackVersionSummary,
  Checkpoint,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessRuntime,
  ProcessStackArgs,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationResult,
  ProjectInfo,
  RecentProjectSummary,
  PtyCreateArgs,
  PtyCreateResult,
  ReparentLaneArgs,
  ReparentLaneResult,
  RenameLaneArgs,
  RestackArgs,
  RestackResult,
  RiskMatrixEntry,
  RequestConflictProposalArgs,
  RunConflictPredictionArgs,
  UndoConflictProposalArgs,
  RunTestSuiteArgs,
  SessionDeltaSummary,
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalProfilesSnapshot,
  TerminalSessionSummary,
  TestRunSummary,
  TestSuiteDefinition,
  UpdateLaneAppearanceArgs,
  WriteTextAtomicArgs
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createPtyService } from "../pty/ptyService";
import type { createDiffService } from "../diffs/diffService";
import type { createFileService } from "../files/fileService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createProcessService } from "../processes/processService";
import type { createTestService } from "../tests/testService";
import type { createGitOperationsService } from "../git/gitOperationsService";
import type { createPackService } from "../packs/packService";
import type { createOperationService } from "../history/operationService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createJobEngine } from "../jobs/jobEngine";
import type { createHostedAgentService } from "../hosted/hostedAgentService";
import type { createGithubService } from "../github/githubService";
import type { createPrService } from "../prs/prService";
import type { createPrPollingService } from "../prs/prPollingService";
import type { createByokLlmService } from "../byok/byokLlmService";
import { readGlobalState, writeGlobalState } from "../state/globalState";
import type { createKeybindingsService } from "../keybindings/keybindingsService";
import type { createTerminalProfilesService } from "../terminalProfiles/terminalProfilesService";
import type { createAgentToolsService } from "../agentTools/agentToolsService";
import type { createOnboardingService } from "../onboarding/onboardingService";
import type { createCiService } from "../ci/ciService";
import type { createAutomationService } from "../automations/automationService";
import type { createAutomationPlannerService } from "../automations/automationPlannerService";

export type AppContext = {
  db: AdeDb;
  logger: Logger;
  project: ProjectInfo;
  projectId: string;
  adeDir: string;
  keybindingsService: ReturnType<typeof createKeybindingsService>;
  terminalProfilesService: ReturnType<typeof createTerminalProfilesService>;
  agentToolsService: ReturnType<typeof createAgentToolsService>;
  onboardingService: ReturnType<typeof createOnboardingService>;
  ciService: ReturnType<typeof createCiService>;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  diffService: ReturnType<typeof createDiffService>;
  fileService: ReturnType<typeof createFileService>;
  operationService: ReturnType<typeof createOperationService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  conflictService: ReturnType<typeof createConflictService>;
  hostedAgentService: ReturnType<typeof createHostedAgentService>;
  byokLlmService: ReturnType<typeof createByokLlmService>;
  githubService: ReturnType<typeof createGithubService>;
  prService: ReturnType<typeof createPrService>;
  prPollingService: ReturnType<typeof createPrPollingService>;
  jobEngine: ReturnType<typeof createJobEngine>;
  automationService: ReturnType<typeof createAutomationService>;
  automationPlannerService: ReturnType<typeof createAutomationPlannerService>;
  packService: ReturnType<typeof createPackService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  processService: ReturnType<typeof createProcessService>;
  testService: ReturnType<typeof createTestService>;
};

function clampLayout(layout: DockLayout): DockLayout {
  const out: DockLayout = {};
  for (const [k, v] of Object.entries(layout)) {
    if (!Number.isFinite(v)) continue;
    out[k] = Math.max(0, Math.min(100, v));
  }
  return out;
}

export function registerIpc({
  getCtx,
  switchProjectFromDialog,
  globalStatePath
}: {
  getCtx: () => AppContext;
  switchProjectFromDialog: (selectedPath: string) => Promise<ProjectInfo>;
  globalStatePath: string;
}) {
  ipcMain.handle(IPC.appPing, async () => "pong" as const);

  ipcMain.handle(IPC.appGetProject, async () => getCtx().project);

  ipcMain.handle(IPC.appOpenExternal, async (_event, arg: { url: string }): Promise<void> => {
    const urlRaw = typeof arg?.url === "string" ? arg.url.trim() : "";
    if (!urlRaw) return;
    let parsed: URL;
    try {
      parsed = new URL(urlRaw);
    } catch {
      throw new Error("Invalid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http(s) URLs are allowed.");
    }
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle(IPC.appGetInfo, async (): Promise<AppInfo> => {
    return {
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron ?? "unknown",
        chrome: process.versions.chrome ?? "unknown",
        node: process.versions.node ?? "unknown",
        v8: process.versions.v8 ?? "unknown"
      },
      env: {
        nodeEnv: process.env.NODE_ENV,
        viteDevServerUrl: process.env.VITE_DEV_SERVER_URL
      }
    };
  });

  ipcMain.handle(IPC.projectOpenRepo, async (event): Promise<ProjectInfo> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "Open repository",
      properties: ["openDirectory"]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return getCtx().project;
    }
    const selected = result.filePaths[0]!;
    return await switchProjectFromDialog(selected);
  });

  ipcMain.handle(IPC.projectOpenAdeFolder, async (): Promise<void> => {
    const ctx = getCtx();
    await shell.openPath(ctx.adeDir);
  });

  ipcMain.handle(IPC.projectClearLocalData, async (_event, arg: ClearLocalAdeDataArgs = {}): Promise<ClearLocalAdeDataResult> => {
    const ctx = getCtx();
    const clearedAt = new Date().toISOString();
    const deletedPaths: string[] = [];

    const rmrf = (absPath: string) => {
      const resolved = path.resolve(absPath);
      const allowedRoot = path.resolve(ctx.adeDir) + path.sep;
      if (!resolved.startsWith(allowedRoot)) {
        throw new Error("Refusing to delete outside .ade directory");
      }
      if (!fs.existsSync(resolved)) return;
      fs.rmSync(resolved, { recursive: true, force: true });
      deletedPaths.push(resolved);
    };

    if (arg.packs) rmrf(path.join(ctx.adeDir, "packs"));
    if (arg.logs) rmrf(path.join(ctx.adeDir, "logs"));
    if (arg.transcripts) rmrf(path.join(ctx.adeDir, "transcripts"));

    return { deletedPaths, clearedAt };
  });

  ipcMain.handle(IPC.projectExportConfig, async (event): Promise<ExportConfigBundleResult> => {
    const ctx = getCtx();
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;

    const snapshot = ctx.projectConfigService.get();
    const sharedPath = snapshot.paths.sharedPath;
    const localPath = snapshot.paths.localPath;

    const readText = (p: string): string => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return "";
      }
    };

    const redactSecrets = (input: string): string => {
      let output = input;
      output = output.replace(
        /((?:api[_-]?key|token|secret|password|refreshToken|accessToken|idToken)\s*:\s*)(["']?)[^\s"']{6,}\2/gi,
        "$1<redacted>"
      );
      output = output.replace(
        /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
        "<redacted-private-key>"
      );
      output = output.replace(
        /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
        "<redacted-token>"
      );
      return output;
    };

    const defaultName = `ade-config-${ctx.project.displayName.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    const defaultPath = path.join(ctx.project.rootPath, defaultName);

    const result = win
      ? await dialog.showSaveDialog(win, {
          title: "Export ADE config",
          defaultPath,
          buttonLabel: "Export",
          filters: [{ name: "JSON", extensions: ["json"] }]
        })
      : await dialog.showSaveDialog({
          title: "Export ADE config",
          defaultPath,
          buttonLabel: "Export",
          filters: [{ name: "JSON", extensions: ["json"] }]
        });

    if (result.canceled || !result.filePath) {
      return { cancelled: true };
    }

    const exportedAt = new Date().toISOString();
    const bundle = {
      exportedAt,
      project: ctx.project,
      config: {
        sharedPath,
        localPath,
        sharedYaml: readText(sharedPath),
        localYamlRedacted: redactSecrets(readText(localPath))
      }
    };

    const content = `${JSON.stringify(bundle, null, 2)}\n`;
    fs.writeFileSync(result.filePath, content, "utf8");

    return {
      cancelled: false,
      savedPath: result.filePath,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      exportedAt
    };
  });

  ipcMain.handle(IPC.projectListRecent, async (): Promise<RecentProjectSummary[]> => {
    const state = readGlobalState(globalStatePath);
    return (state.recentProjects ?? []).map((entry) => ({
      rootPath: entry.rootPath,
      displayName: entry.displayName,
      lastOpenedAt: entry.lastOpenedAt
    }));
  });

  ipcMain.handle(IPC.projectForgetRecent, async (_event, arg: { rootPath: string }): Promise<RecentProjectSummary[]> => {
    const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
    if (!rootPath) {
      const state = readGlobalState(globalStatePath);
      return (state.recentProjects ?? []).map((entry) => ({
        rootPath: entry.rootPath,
        displayName: entry.displayName,
        lastOpenedAt: entry.lastOpenedAt
      }));
    }
    const state = readGlobalState(globalStatePath);
    const filtered = (state.recentProjects ?? []).filter((entry) => entry.rootPath !== rootPath);
    const next = { ...state, recentProjects: filtered };
    if (next.lastProjectRoot === rootPath) {
      delete next.lastProjectRoot;
    }
    writeGlobalState(globalStatePath, next);
    return filtered.map((entry) => ({
      rootPath: entry.rootPath,
      displayName: entry.displayName,
      lastOpenedAt: entry.lastOpenedAt
    }));
  });

  ipcMain.handle(IPC.projectSwitchToPath, async (_event, arg: { rootPath: string }): Promise<ProjectInfo> => {
    const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
    if (!rootPath) return getCtx().project;
    if (rootPath === getCtx().project.rootPath) return getCtx().project;
    return await switchProjectFromDialog(rootPath);
  });

  ipcMain.handle(IPC.keybindingsGet, async (): Promise<KeybindingsSnapshot> => {
    const ctx = getCtx();
    return ctx.keybindingsService.get();
  });

  ipcMain.handle(IPC.keybindingsSet, async (_event, arg: { overrides: KeybindingOverride[] }): Promise<KeybindingsSnapshot> => {
    const ctx = getCtx();
    return ctx.keybindingsService.set({ overrides: arg?.overrides ?? [] });
  });

  ipcMain.handle(IPC.agentToolsDetect, async (): Promise<AgentTool[]> => {
    const ctx = getCtx();
    return ctx.agentToolsService.detect();
  });

  ipcMain.handle(IPC.terminalProfilesGet, async (): Promise<TerminalProfilesSnapshot> => {
    const ctx = getCtx();
    return ctx.terminalProfilesService.get();
  });

  ipcMain.handle(IPC.terminalProfilesSet, async (_event, arg: TerminalProfilesSnapshot): Promise<TerminalProfilesSnapshot> => {
    const ctx = getCtx();
    return ctx.terminalProfilesService.set(arg);
  });

  ipcMain.handle(IPC.onboardingGetStatus, async (): Promise<OnboardingStatus> => {
    const ctx = getCtx();
    return ctx.onboardingService.getStatus();
  });

  ipcMain.handle(IPC.onboardingDetectDefaults, async (): Promise<OnboardingDetectionResult> => {
    const ctx = getCtx();
    return await ctx.onboardingService.detectDefaults();
  });

  ipcMain.handle(IPC.onboardingDetectExistingLanes, async (): Promise<OnboardingExistingLaneCandidate[]> => {
    const ctx = getCtx();
    return await ctx.onboardingService.detectExistingLanes();
  });

  ipcMain.handle(IPC.onboardingGenerateInitialPacks, async (_event, arg: { laneIds?: string[] } = {}): Promise<void> => {
    const ctx = getCtx();
    await ctx.onboardingService.generateInitialPacks({ laneIds: arg.laneIds });
  });

  ipcMain.handle(IPC.onboardingComplete, async (): Promise<OnboardingStatus> => {
    const ctx = getCtx();
    return ctx.onboardingService.complete();
  });

  ipcMain.handle(IPC.ciScan, async (): Promise<CiScanResult> => {
    const ctx = getCtx();
    return await ctx.ciService.scan();
  });

  ipcMain.handle(IPC.ciImport, async (_event, arg: CiImportRequest): Promise<CiImportResult> => {
    const ctx = getCtx();
    return await ctx.ciService.import(arg);
  });

  ipcMain.handle(IPC.automationsList, async (): Promise<AutomationRuleSummary[]> => {
    const ctx = getCtx();
    return ctx.automationService.list();
  });

  ipcMain.handle(IPC.automationsToggle, async (_event, arg: { id: string; enabled: boolean }): Promise<AutomationRuleSummary[]> => {
    const ctx = getCtx();
    return ctx.automationService.toggle({ id: arg?.id ?? "", enabled: Boolean(arg?.enabled) });
  });

  ipcMain.handle(IPC.automationsTriggerManually, async (_event, arg: { id: string; laneId?: string | null }): Promise<AutomationRun> => {
    const ctx = getCtx();
    return await ctx.automationService.triggerManually({ id: arg?.id ?? "", laneId: arg?.laneId ?? null });
  });

  ipcMain.handle(IPC.automationsGetHistory, async (_event, arg: { id: string; limit?: number }): Promise<AutomationRun[]> => {
    const ctx = getCtx();
    return ctx.automationService.getHistory({ id: arg?.id ?? "", limit: arg?.limit });
  });

  ipcMain.handle(IPC.automationsGetRunDetail, async (_event, arg: { runId: string }): Promise<AutomationRunDetail | null> => {
    const ctx = getCtx();
    return ctx.automationService.getRunDetail({ runId: arg?.runId ?? "" });
  });

  ipcMain.handle(IPC.automationsParseNaturalLanguage, async (_event, arg: AutomationParseNaturalLanguageRequest): Promise<AutomationParseNaturalLanguageResult> => {
    const ctx = getCtx();
    return await ctx.automationPlannerService.parseNaturalLanguage(arg);
  });

  ipcMain.handle(IPC.automationsValidateDraft, async (_event, arg: AutomationValidateDraftRequest): Promise<AutomationValidateDraftResult> => {
    const ctx = getCtx();
    return ctx.automationPlannerService.validateDraft(arg);
  });

  ipcMain.handle(IPC.automationsSaveDraft, async (_event, arg: AutomationSaveDraftRequest): Promise<AutomationSaveDraftResult> => {
    const ctx = getCtx();
    return ctx.automationPlannerService.saveDraft(arg);
  });

  ipcMain.handle(IPC.automationsSimulate, async (_event, arg: AutomationSimulateRequest): Promise<AutomationSimulateResult> => {
    const ctx = getCtx();
    return ctx.automationPlannerService.simulate(arg);
  });

  ipcMain.handle(IPC.layoutGet, async (_event, arg: { layoutId: string }): Promise<DockLayout | null> => {
    const ctx = getCtx();
    const key = `dock_layout:${arg.layoutId}`;
    const value = ctx.db.getJson<DockLayout>(key);
    ctx.logger.debug("layout.get", { key, hit: value != null });
    return value;
  });

  ipcMain.handle(IPC.layoutSet, async (_event, arg: { layoutId: string; layout: DockLayout }): Promise<void> => {
    const ctx = getCtx();
    const key = `dock_layout:${arg.layoutId}`;
    const safe = clampLayout(arg.layout);
    ctx.db.setJson(key, safe);
    ctx.logger.debug("layout.set", { key, panels: Object.keys(safe).length });
  });

  ipcMain.handle(IPC.graphStateGet, async (_event, arg: { projectId: string }): Promise<GraphPersistedState | null> => {
    const ctx = getCtx();
    const key = `graph_state:${arg.projectId}`;
    return ctx.db.getJson<GraphPersistedState>(key);
  });

  ipcMain.handle(IPC.graphStateSet, async (_event, arg: { projectId: string; state: GraphPersistedState }): Promise<void> => {
    const ctx = getCtx();
    const key = `graph_state:${arg.projectId}`;
    ctx.db.setJson(key, arg.state);
  });

  ipcMain.handle(IPC.lanesList, async (_event, arg: ListLanesArgs): Promise<LaneSummary[]> => {
    const ctx = getCtx();
    return await ctx.laneService.list(arg);
  });

  ipcMain.handle(IPC.lanesCreate, async (_event, arg: CreateLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.create({ name: arg.name, description: arg.description, parentLaneId: arg.parentLaneId });
  });

  ipcMain.handle(IPC.lanesCreateChild, async (_event, arg: CreateChildLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.createChild(arg);
  });

  ipcMain.handle(IPC.lanesImportBranch, async (_event, arg: ImportBranchLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.importBranch(arg);
  });

  ipcMain.handle(IPC.lanesAttach, async (_event, arg: AttachLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.attach(arg);
  });

  ipcMain.handle(IPC.lanesRename, async (_event, arg: RenameLaneArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.laneService.rename(arg);
  });

  ipcMain.handle(IPC.lanesReparent, async (_event, arg: ReparentLaneArgs): Promise<ReparentLaneResult> => {
    const ctx = getCtx();
    return await ctx.laneService.reparent(arg);
  });

  ipcMain.handle(IPC.lanesUpdateAppearance, async (_event, arg: UpdateLaneAppearanceArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.laneService.updateAppearance(arg);
  });

  ipcMain.handle(IPC.lanesArchive, async (_event, arg: ArchiveLaneArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.laneService.archive(arg);
  });

  ipcMain.handle(IPC.lanesDelete, async (_event, arg: DeleteLaneArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.laneService.delete(arg);
  });

  ipcMain.handle(IPC.lanesGetStackChain, async (_event, arg: { laneId: string }): Promise<StackChainItem[]> => {
    const ctx = getCtx();
    return await ctx.laneService.getStackChain(arg.laneId);
  });

  ipcMain.handle(IPC.lanesGetChildren, async (_event, arg: { laneId: string }): Promise<LaneSummary[]> => {
    const ctx = getCtx();
    return await ctx.laneService.getChildren(arg.laneId);
  });

  ipcMain.handle(IPC.lanesRestack, async (_event, arg: RestackArgs): Promise<RestackResult> => {
    const ctx = getCtx();
    return await ctx.laneService.restack(arg);
  });

  ipcMain.handle(IPC.lanesOpenFolder, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    const worktreePath = ctx.laneService.getLaneWorktreePath(arg.laneId);
    await shell.openPath(worktreePath);
  });

  ipcMain.handle(IPC.sessionsList, async (_event, arg: ListSessionsArgs): Promise<TerminalSessionSummary[]> => {
    const ctx = getCtx();
    return ctx.sessionService.list(arg);
  });

  ipcMain.handle(IPC.sessionsGet, async (_event, arg: { sessionId: string }): Promise<TerminalSessionDetail | null> => {
    const ctx = getCtx();
    return ctx.sessionService.get(arg.sessionId);
  });

  ipcMain.handle(IPC.sessionsReadTranscriptTail, async (_event, arg: { sessionId: string; maxBytes?: number }): Promise<string> => {
    const ctx = getCtx();
    const session = ctx.sessionService.get(arg.sessionId);
    if (!session) return "";
    const maxBytes = typeof arg.maxBytes === "number" ? Math.max(1024, Math.min(2_000_000, arg.maxBytes)) : 160_000;
    return ctx.sessionService.readTranscriptTail(session.transcriptPath, maxBytes);
  });

  ipcMain.handle(IPC.sessionsGetDelta, async (_event, arg: { sessionId: string }): Promise<SessionDeltaSummary | null> => {
    const ctx = getCtx();
    return ctx.packService.getSessionDelta(arg.sessionId);
  });

  ipcMain.handle(IPC.ptyCreate, async (_event, arg: PtyCreateArgs): Promise<PtyCreateResult> => {
    const ctx = getCtx();
    return await ctx.ptyService.create(arg);
  });

  ipcMain.handle(IPC.ptyWrite, async (_event, arg: { ptyId: string; data: string }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.write(arg);
  });

  ipcMain.handle(IPC.ptyResize, async (_event, arg: { ptyId: string; cols: number; rows: number }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.resize(arg);
  });

  ipcMain.handle(IPC.ptyDispose, async (_event, arg: { ptyId: string; sessionId?: string }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.dispose(arg);
  });

  ipcMain.handle(IPC.diffGetChanges, async (_event, arg: GetDiffChangesArgs) => {
    const ctx = getCtx();
    return await ctx.diffService.getChanges(arg.laneId);
  });

  ipcMain.handle(IPC.diffGetFile, async (_event, arg: GetFileDiffArgs) => {
    const ctx = getCtx();
    return await ctx.diffService.getFileDiff({
      laneId: arg.laneId,
      filePath: arg.path,
      mode: arg.mode,
      compareRef: arg.compareRef,
      compareTo: arg.compareTo
    });
  });

  ipcMain.handle(IPC.filesWriteTextAtomic, async (_event, arg: WriteTextAtomicArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.writeTextAtomic({ laneId: arg.laneId, relPath: arg.path, text: arg.text });
  });

  ipcMain.handle(IPC.filesListWorkspaces, async (_event, arg: FilesListWorkspacesArgs = {}): Promise<FilesWorkspace[]> => {
    const ctx = getCtx();
    return ctx.fileService.listWorkspaces(arg);
  });

  ipcMain.handle(IPC.filesListTree, async (_event, arg: FilesListTreeArgs): Promise<FileTreeNode[]> => {
    const ctx = getCtx();
    return await ctx.fileService.listTree(arg);
  });

  ipcMain.handle(IPC.filesReadFile, async (_event, arg: FilesReadFileArgs): Promise<FileContent> => {
    const ctx = getCtx();
    return ctx.fileService.readFile(arg);
  });

  ipcMain.handle(IPC.filesWriteText, async (_event, arg: FilesWriteTextArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.writeWorkspaceText(arg);
  });

  ipcMain.handle(IPC.filesCreateFile, async (_event, arg: FilesCreateFileArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.createFile(arg);
  });

  ipcMain.handle(IPC.filesCreateDirectory, async (_event, arg: FilesCreateDirectoryArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.createDirectory(arg);
  });

  ipcMain.handle(IPC.filesRename, async (_event, arg: FilesRenameArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.rename(arg);
  });

  ipcMain.handle(IPC.filesDelete, async (_event, arg: FilesDeleteArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.deletePath(arg);
  });

  ipcMain.handle(IPC.filesWatchChanges, async (event, arg: FilesWatchArgs): Promise<void> => {
    const ctx = getCtx();
    const senderId = event.sender.id;
    await ctx.fileService.watchWorkspace(arg, (payload: FileChangeEvent) => {
      try {
        event.sender.send(IPC.filesChange, payload);
      } catch {
        // ignore detached renderer
      }
    }, senderId);
  });

  ipcMain.handle(IPC.filesStopWatching, async (event, arg: FilesWatchArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.stopWatching(arg, event.sender.id);
  });

  ipcMain.handle(IPC.filesQuickOpen, async (_event, arg: FilesQuickOpenArgs): Promise<FilesQuickOpenItem[]> => {
    const ctx = getCtx();
    return await ctx.fileService.quickOpen(arg);
  });

  ipcMain.handle(IPC.filesSearchText, async (_event, arg: FilesSearchTextArgs): Promise<FilesSearchTextMatch[]> => {
    const ctx = getCtx();
    return await ctx.fileService.searchText(arg);
  });

  ipcMain.handle(IPC.gitStageFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stageFile(arg);
  });

  ipcMain.handle(IPC.gitUnstageFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.unstageFile(arg);
  });

  ipcMain.handle(IPC.gitDiscardFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.discardFile(arg);
  });

  ipcMain.handle(IPC.gitRestoreStagedFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.restoreStagedFile(arg);
  });

  ipcMain.handle(IPC.gitCommit, async (_event, arg: GitCommitArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.commit(arg);
  });

  ipcMain.handle(IPC.gitListRecentCommits, async (_event, arg: { laneId: string; limit?: number }): Promise<GitCommitSummary[]> => {
    const ctx = getCtx();
    return ctx.gitService.listRecentCommits(arg);
  });

  ipcMain.handle(IPC.gitListCommitFiles, async (_event, arg: GitListCommitFilesArgs): Promise<string[]> => {
    const ctx = getCtx();
    return await ctx.gitService.listCommitFiles(arg);
  });

  ipcMain.handle(IPC.gitGetCommitMessage, async (_event, arg: GitGetCommitMessageArgs): Promise<string> => {
    const ctx = getCtx();
    return await ctx.gitService.getCommitMessage(arg);
  });

  ipcMain.handle(IPC.gitRevertCommit, async (_event, arg: GitRevertArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.revertCommit(arg);
  });

  ipcMain.handle(IPC.gitCherryPickCommit, async (_event, arg: GitCherryPickArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.cherryPickCommit(arg);
  });

  ipcMain.handle(IPC.gitStashPush, async (_event, arg: GitStashPushArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashPush(arg);
  });

  ipcMain.handle(IPC.gitStashList, async (_event, arg: { laneId: string }): Promise<GitStashSummary[]> => {
    const ctx = getCtx();
    return ctx.gitService.listStashes(arg);
  });

  ipcMain.handle(IPC.gitStashApply, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashApply(arg);
  });

  ipcMain.handle(IPC.gitStashPop, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashPop(arg);
  });

  ipcMain.handle(IPC.gitStashDrop, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashDrop(arg);
  });

  ipcMain.handle(IPC.gitFetch, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.fetch(arg);
  });

  ipcMain.handle(IPC.gitSync, async (_event, arg: GitSyncArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.sync(arg);
  });

  ipcMain.handle(IPC.gitPush, async (_event, arg: GitPushArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.push(arg);
  });

  ipcMain.handle(IPC.gitGetConflictState, async (_event, arg: { laneId: string }): Promise<GitConflictState> => {
    const ctx = getCtx();
    return await ctx.gitService.getConflictState({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitRebaseContinue, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.rebaseContinue({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitRebaseAbort, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.rebaseAbort({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitMergeContinue, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.mergeContinue({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitMergeAbort, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.mergeAbort({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.conflictsGetLaneStatus, async (_event, arg: GetLaneConflictStatusArgs): Promise<ConflictStatus> => {
    const ctx = getCtx();
    return await ctx.conflictService.getLaneStatus(arg);
  });

  ipcMain.handle(IPC.conflictsListOverlaps, async (_event, arg: ListOverlapsArgs): Promise<ConflictOverlap[]> => {
    const ctx = getCtx();
    return await ctx.conflictService.listOverlaps(arg);
  });

  ipcMain.handle(IPC.conflictsGetRiskMatrix, async (): Promise<RiskMatrixEntry[]> => {
    const ctx = getCtx();
    return await ctx.conflictService.getRiskMatrix();
  });

  ipcMain.handle(IPC.conflictsSimulateMerge, async (_event, arg: MergeSimulationArgs): Promise<MergeSimulationResult> => {
    const ctx = getCtx();
    return await ctx.conflictService.simulateMerge(arg);
  });

  ipcMain.handle(IPC.conflictsRunPrediction, async (_event, arg: RunConflictPredictionArgs = {}): Promise<BatchAssessmentResult> => {
    const ctx = getCtx();
    return await ctx.conflictService.runPrediction(arg);
  });

  ipcMain.handle(IPC.conflictsGetBatchAssessment, async (): Promise<BatchAssessmentResult> => {
    const ctx = getCtx();
    return await ctx.conflictService.getBatchAssessment();
  });

  ipcMain.handle(IPC.conflictsListProposals, async (_event, arg: { laneId: string }): Promise<ConflictProposal[]> => {
    const ctx = getCtx();
    return await ctx.conflictService.listProposals({ laneId: arg.laneId });
  });

  ipcMain.handle(IPC.conflictsRequestProposal, async (_event, arg: RequestConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = getCtx();
    return await ctx.conflictService.requestProposal(arg);
  });

  ipcMain.handle(IPC.conflictsApplyProposal, async (_event, arg: ApplyConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = getCtx();
    const updated = await ctx.conflictService.applyProposal(arg);
    ctx.jobEngine.runConflictPredictionNow({ laneId: arg.laneId });
    return updated;
  });

  ipcMain.handle(IPC.conflictsUndoProposal, async (_event, arg: UndoConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = getCtx();
    const updated = await ctx.conflictService.undoProposal(arg);
    ctx.jobEngine.runConflictPredictionNow({ laneId: arg.laneId });
    return updated;
  });

  ipcMain.handle(IPC.packsGetProjectPack, async (): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getProjectPack();
  });

  ipcMain.handle(IPC.packsGetLanePack, async (_event, arg: { laneId: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getLanePack(arg.laneId);
  });

  ipcMain.handle(IPC.packsRefreshLanePack, async (_event, arg: { laneId: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    const lanePack = await ctx.packService.refreshLanePack({
      laneId: arg.laneId,
      reason: "manual_refresh"
    });
    await ctx.packService.refreshProjectPack({
      reason: "manual_refresh",
      laneId: arg.laneId
    });
    return lanePack;
  });

  ipcMain.handle(IPC.packsApplyHostedNarrative, async (_event, arg: { laneId: string; narrative: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.applyHostedNarrative({
      laneId: arg.laneId,
      narrative: arg.narrative
    });
  });

  ipcMain.handle(IPC.packsGenerateNarrative, async (_event, arg: { laneId: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    const lanePack = ctx.packService.getLanePack(arg.laneId);
    if (!lanePack.exists || !lanePack.body.trim().length) {
      throw new Error("Lane pack is empty. Refresh the deterministic pack first.");
    }

    const providerMode = ctx.projectConfigService.get().effective.providerMode ?? "guest";
    if (providerMode === "hosted" && ctx.hostedAgentService.getStatus().enabled) {
      const narrative = await ctx.hostedAgentService.requestLaneNarrative({
        laneId: arg.laneId,
        packBody: lanePack.body
      });
      return ctx.packService.applyHostedNarrative({
        laneId: arg.laneId,
        narrative: narrative.narrative,
        metadata: {
          jobId: narrative.jobId,
          artifactId: narrative.artifactId
        }
      });
    }

    if (providerMode === "byok") {
      const narrative = await ctx.byokLlmService.generateLaneNarrative({
        laneId: arg.laneId,
        packBody: lanePack.body
      });
      return ctx.packService.applyHostedNarrative({
        laneId: arg.laneId,
        narrative: narrative.narrative,
        metadata: {
          source: "byok",
          provider: narrative.provider,
          model: narrative.model
        }
      });
    }

    throw new Error("AI narrative generation requires Hosted or BYOK provider mode.");
  });

  ipcMain.handle(IPC.packsGetFeaturePack, async (_event, arg: { featureKey: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getFeaturePack(arg.featureKey);
  });

  ipcMain.handle(
    IPC.packsGetConflictPack,
    async (_event, arg: { laneId: string; peerLaneId?: string | null }): Promise<PackSummary> => {
      const ctx = getCtx();
      return ctx.packService.getConflictPack({ laneId: arg.laneId, peerLaneId: arg.peerLaneId ?? null });
    }
  );

  ipcMain.handle(IPC.packsGetPlanPack, async (_event, arg: { laneId: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getPlanPack(arg.laneId);
  });

  ipcMain.handle(IPC.packsRefreshFeaturePack, async (_event, arg: { featureKey: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return await ctx.packService.refreshFeaturePack({ featureKey: arg.featureKey, reason: "manual_refresh" });
  });

  ipcMain.handle(
    IPC.packsRefreshConflictPack,
    async (_event, arg: { laneId: string; peerLaneId?: string | null }): Promise<PackSummary> => {
      const ctx = getCtx();
      return await ctx.packService.refreshConflictPack({
        laneId: arg.laneId,
        peerLaneId: arg.peerLaneId ?? null,
        reason: "manual_refresh"
      });
    }
  );

  ipcMain.handle(IPC.packsSavePlanPack, async (_event, arg: { laneId: string; body: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return await ctx.packService.savePlanPack({ laneId: arg.laneId, body: arg.body, reason: "manual_save" });
  });

  ipcMain.handle(IPC.packsListVersions, async (_event, arg: { packKey: string; limit?: number }): Promise<PackVersionSummary[]> => {
    const ctx = getCtx();
    return ctx.packService.listVersions({ packKey: arg.packKey, limit: arg.limit });
  });

  ipcMain.handle(IPC.packsGetVersion, async (_event, arg: { versionId: string }): Promise<PackVersion> => {
    const ctx = getCtx();
    return ctx.packService.getVersion(arg.versionId);
  });

  ipcMain.handle(
    IPC.packsDiffVersions,
    async (_event, arg: { fromId: string; toId: string }): Promise<string> => {
      const ctx = getCtx();
      return await ctx.packService.diffVersions(arg);
    }
  );

  ipcMain.handle(
    IPC.packsUpdateNarrative,
    async (_event, arg: { packKey: string; narrative: string }): Promise<PackSummary> => {
      const ctx = getCtx();
      return ctx.packService.updateNarrative({ packKey: arg.packKey, narrative: arg.narrative, source: "user" });
    }
  );

  ipcMain.handle(
    IPC.packsListEvents,
    async (_event, arg: { packKey: string; limit?: number }): Promise<PackEvent[]> => {
      const ctx = getCtx();
      return ctx.packService.listEvents({ packKey: arg.packKey, limit: arg.limit });
    }
  );

  ipcMain.handle(
    IPC.packsListCheckpoints,
    async (_event, arg: { laneId?: string; limit?: number } = {}): Promise<Checkpoint[]> => {
      const ctx = getCtx();
      return ctx.packService.listCheckpoints({ laneId: arg.laneId, limit: arg.limit });
    }
  );

  ipcMain.handle(IPC.hostedGetStatus, async (): Promise<HostedStatus> => {
    const ctx = getCtx();
    return ctx.hostedAgentService.getStatus();
  });

  ipcMain.handle(IPC.hostedGetBootstrapConfig, async (): Promise<HostedBootstrapConfig | null> => {
    const ctx = getCtx();
    return ctx.hostedAgentService.getBootstrapConfig();
  });

  ipcMain.handle(IPC.hostedApplyBootstrapConfig, async (): Promise<HostedBootstrapConfig> => {
    const ctx = getCtx();
    return ctx.hostedAgentService.applyBootstrapConfig();
  });

  ipcMain.handle(IPC.hostedSignIn, async (_event, arg: HostedSignInArgs = {}): Promise<HostedSignInResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.signIn(arg);
  });

  ipcMain.handle(IPC.hostedSignOut, async (): Promise<void> => {
    const ctx = getCtx();
    ctx.hostedAgentService.signOut();
  });

  ipcMain.handle(IPC.hostedSyncMirror, async (_event, arg: HostedMirrorSyncArgs = {}): Promise<HostedMirrorSyncResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.syncMirror(arg);
  });

  ipcMain.handle(IPC.hostedDeleteMirrorData, async (): Promise<HostedMirrorDeleteResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.deleteMirrorData();
  });

  ipcMain.handle(IPC.hostedSubmitJob, async (_event, arg: HostedJobSubmissionArgs): Promise<HostedJobSubmissionResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.submitJob(arg);
  });

  ipcMain.handle(IPC.hostedGetJob, async (_event, arg: { jobId: string }): Promise<HostedJobStatusResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.getJob(arg.jobId);
  });

  ipcMain.handle(IPC.hostedGetArtifact, async (_event, arg: { artifactId: string }): Promise<HostedArtifactResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.getArtifact(arg.artifactId);
  });

  ipcMain.handle(IPC.hostedGithubGetStatus, async (): Promise<HostedGitHubAppStatus> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.githubGetStatus();
  });

  ipcMain.handle(IPC.hostedGithubConnectStart, async (): Promise<HostedGitHubConnectStartResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.githubConnectStart();
  });

  ipcMain.handle(IPC.hostedGithubDisconnect, async (): Promise<HostedGitHubDisconnectResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.githubDisconnect();
  });

  ipcMain.handle(IPC.hostedGithubListEvents, async (): Promise<HostedGitHubEventsResult> => {
    const ctx = getCtx();
    return await ctx.hostedAgentService.githubListEvents();
  });

  ipcMain.handle(IPC.githubGetStatus, async (): Promise<GitHubStatus> => {
    const ctx = getCtx();
    return await ctx.githubService.getStatus();
  });

  ipcMain.handle(IPC.githubSetToken, async (_event, arg: { token: string }): Promise<GitHubStatus> => {
    const ctx = getCtx();
    ctx.githubService.setToken(arg.token);
    return await ctx.githubService.getStatus();
  });

  ipcMain.handle(IPC.githubClearToken, async (): Promise<GitHubStatus> => {
    const ctx = getCtx();
    ctx.githubService.clearToken();
    return await ctx.githubService.getStatus();
  });

  ipcMain.handle(IPC.prsCreateFromLane, async (_event, arg: CreatePrFromLaneArgs): Promise<PrSummary> => {
    const ctx = getCtx();
    return await ctx.prService.createFromLane(arg);
  });

  ipcMain.handle(IPC.prsLinkToLane, async (_event, arg: LinkPrToLaneArgs): Promise<PrSummary> => {
    const ctx = getCtx();
    return await ctx.prService.linkToLane(arg);
  });

  ipcMain.handle(IPC.prsGetForLane, async (_event, arg: { laneId: string }): Promise<PrSummary | null> => {
    const ctx = getCtx();
    return ctx.prService.getForLane(arg.laneId);
  });

  ipcMain.handle(IPC.prsListAll, async (): Promise<PrSummary[]> => {
    const ctx = getCtx();
    return ctx.prService.listAll();
  });

  ipcMain.handle(IPC.prsRefresh, async (_event, arg: { prId?: string } = {}): Promise<PrSummary[]> => {
    const ctx = getCtx();
    return await ctx.prService.refresh(arg);
  });

  ipcMain.handle(IPC.prsGetStatus, async (_event, arg: { prId: string }): Promise<PrStatus> => {
    const ctx = getCtx();
    return await ctx.prService.getStatus(arg.prId);
  });

  ipcMain.handle(IPC.prsGetChecks, async (_event, arg: { prId: string }): Promise<PrCheck[]> => {
    const ctx = getCtx();
    return await ctx.prService.getChecks(arg.prId);
  });

  ipcMain.handle(IPC.prsGetReviews, async (_event, arg: { prId: string }): Promise<PrReview[]> => {
    const ctx = getCtx();
    return await ctx.prService.getReviews(arg.prId);
  });

  ipcMain.handle(IPC.prsUpdateDescription, async (_event, arg: UpdatePrDescriptionArgs): Promise<void> => {
    const ctx = getCtx();
    return await ctx.prService.updateDescription(arg);
  });

  ipcMain.handle(IPC.prsDraftDescription, async (_event, arg: { laneId: string }): Promise<{ title: string; body: string }> => {
    const ctx = getCtx();
    return await ctx.prService.draftDescription(arg.laneId);
  });

  ipcMain.handle(IPC.prsLand, async (_event, arg: LandPrArgs): Promise<LandResult> => {
    const ctx = getCtx();
    return await ctx.prService.land(arg);
  });

  ipcMain.handle(IPC.prsLandStack, async (_event, arg: LandStackArgs): Promise<LandResult[]> => {
    const ctx = getCtx();
    return await ctx.prService.landStack(arg);
  });

  ipcMain.handle(IPC.prsOpenInGitHub, async (_event, arg: { prId: string }): Promise<void> => {
    const ctx = getCtx();
    return await ctx.prService.openInGitHub(arg.prId);
  });

  ipcMain.handle(IPC.historyListOperations, async (_event, arg: ListOperationsArgs = {}): Promise<OperationRecord[]> => {
    const ctx = getCtx();
    return ctx.operationService.list(arg);
  });

  ipcMain.handle(IPC.processesListDefinitions, async (): Promise<ProcessDefinition[]> => {
    const ctx = getCtx();
    return ctx.processService.listDefinitions();
  });

  ipcMain.handle(IPC.processesListRuntime, async (_event, arg: { laneId: string }): Promise<ProcessRuntime[]> => {
    const ctx = getCtx();
    if (!arg?.laneId) return [];
    return ctx.processService.listRuntime(arg.laneId);
  });

  ipcMain.handle(IPC.processesStart, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    return await ctx.processService.start(arg);
  });

  ipcMain.handle(IPC.processesStop, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    return await ctx.processService.stop(arg);
  });

  ipcMain.handle(IPC.processesRestart, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    return await ctx.processService.restart(arg);
  });

  ipcMain.handle(IPC.processesKill, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    return await ctx.processService.kill(arg);
  });

  ipcMain.handle(IPC.processesStartStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.startStack(arg);
  });

  ipcMain.handle(IPC.processesStopStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.stopStack(arg);
  });

  ipcMain.handle(IPC.processesRestartStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.restartStack(arg);
  });

  ipcMain.handle(IPC.processesStartAll, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    if (!arg?.laneId) return;
    await ctx.processService.startAll(arg);
  });

  ipcMain.handle(IPC.processesStopAll, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    if (!arg?.laneId) return;
    await ctx.processService.stopAll(arg);
  });

  ipcMain.handle(IPC.processesGetLogTail, async (_event, arg: GetProcessLogTailArgs): Promise<string> => {
    const ctx = getCtx();
    return ctx.processService.getLogTail(arg);
  });

  ipcMain.handle(IPC.testsListSuites, async (): Promise<TestSuiteDefinition[]> => {
    const ctx = getCtx();
    return ctx.testService.listSuites();
  });

  ipcMain.handle(IPC.testsRun, async (_event, arg: RunTestSuiteArgs): Promise<TestRunSummary> => {
    const ctx = getCtx();
    return ctx.testService.run(arg);
  });

  ipcMain.handle(IPC.testsStop, async (_event, arg: StopTestRunArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.testService.stop(arg);
  });

  ipcMain.handle(IPC.testsListRuns, async (_event, arg: ListTestRunsArgs = {}): Promise<TestRunSummary[]> => {
    const ctx = getCtx();
    return ctx.testService.listRuns(arg);
  });

  ipcMain.handle(IPC.testsGetLogTail, async (_event, arg: GetTestLogTailArgs): Promise<string> => {
    const ctx = getCtx();
    return ctx.testService.getLogTail(arg);
  });

  ipcMain.handle(IPC.projectConfigGet, async (): Promise<ProjectConfigSnapshot> => {
    const ctx = getCtx();
    return ctx.projectConfigService.get();
  });

  ipcMain.handle(IPC.projectConfigValidate, async (_event, arg: { candidate: ProjectConfigCandidate }): Promise<ProjectConfigValidationResult> => {
    const ctx = getCtx();
    return ctx.projectConfigService.validate(arg.candidate);
  });

  ipcMain.handle(IPC.projectConfigSave, async (_event, arg: { candidate: ProjectConfigCandidate }): Promise<ProjectConfigSnapshot> => {
    const ctx = getCtx();
    const next = ctx.projectConfigService.save(arg.candidate);
    try {
      ctx.automationService.syncFromConfig();
    } catch {
      // ignore schedule refresh failures
    }
    return next;
  });

  ipcMain.handle(IPC.projectConfigDiffAgainstDisk, async (): Promise<ProjectConfigDiff> => {
    const ctx = getCtx();
    return ctx.projectConfigService.diffAgainstDisk();
  });

  ipcMain.handle(IPC.projectConfigConfirmTrust, async (_event, arg: { sharedHash?: string } = {}): Promise<ProjectConfigTrust> => {
    const ctx = getCtx();
    return ctx.projectConfigService.confirmTrust(arg);
  });
}
