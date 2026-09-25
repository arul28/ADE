import path from "node:path";
import { appControlProofCaption } from "../../../shared/proofProvenance";
import { MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE } from "../../../shared/types/macDesktop";
import type {
  AppControlAgentClearArgs,
  AppControlAgentClickArgs,
  AppControlAgentFillArgs,
  AppControlAgentHoverArgs,
  AppControlAgentPressArgs,
  AppControlAgentScrollArgs,
  AppControlAgentTypeArgs,
  AppControlAgentWaitArgs,
  AppControlAttachToTargetArgs,
  AppControlCaptureProofArgs,
  AppControlCaptureProofResult,
  AppControlClaimArgs,
  AppControlClickArgs,
  AppControlConnectArgs,
  AppControlContextItem,
  AppControlDispatchKeyArgs,
  AppControlDriversResult,
  AppControlInspectPointArgs,
  AppControlInspectResult,
  AppControlLaunchArgs,
  AppControlObservationArgs,
  AppControlRecordStartArgs,
  AppControlRecordStopArgs,
  AppControlRecordingStatus,
  AppControlRecordingStatusArgs,
  AppControlScreencastFrame,
  AppControlScrollArgs,
  AppControlSelectResult,
  AppControlSession,
  AppControlSessionTargetArgs,
  AppControlSnapshot,
  AppControlSnapshotArgs,
  AppControlStatus,
  AppControlStopArgs,
  AppControlSwitchWindowArgs,
  AppControlTarget,
  AppControlTraceArgs,
  AppControlTypeTextArgs,
  AppControlWindowsResult,
} from "../../../shared/types";
import { APP_CONTROL_PROOF_BACKEND_NAME, createAppControlRecording } from "./appControlRecording";
import { createAppControlWindowRecorder } from "./appControlWindowRecorder";
import type { ComputerUseArtifactIngestionResult, ComputerUseArtifactOwner } from "../../../shared/types/computerUseArtifacts";
import {
  asPositiveInt,
  cleanClaimId,
  createAppControlLaneController,
  listDriversFor,
  normalizeCwd,
  normalizeProjectRoot,
  providersFor,
  readAppProcessId,
  requireSupportedDriver,
  type AppControlLaneController,
  type AppControlLaneRef,
  type CreateAppControlServiceArgs,
} from "./appControlLaneController";

export type AppControlService = ReturnType<typeof createAppControlService>;

export function createAppControlService(args: CreateAppControlServiceArgs) {
  // Bounded LRU cache scoped to this service instance — dies with the service,
  // so rebuilding the project naturally invalidates stale paths. Capped to
  // SOURCE_FILE_CACHE_MAX entries to keep growth bounded.
  const sourceFileCache = new Map<string, string[]>();
  /** laneId → that lane's session machinery. One service per project, one session per lane. */
  const controllers = new Map<string, AppControlLaneController>();

  const recording = createAppControlRecording({
    logger: args.logger,
    projectRoot: args.projectRoot,
    emit: (payload) => args.onEvent?.(payload),
    getSession: (laneId) => controllers.get(laneId)?.getSession() ?? null,
    getLastFrame: (laneId) => controllers.get(laneId)?.getLastFrame() ?? null,
    resolveAppProcessId: async (laneId) => await controllers.get(laneId)?.resolveAppProcessId() ?? null,
    resolveTargetTitle: async (laneId) => await controllers.get(laneId)?.getTargetTitle() ?? null,
    windowRecorder: args.windowRecorder !== undefined
      ? args.windowRecorder
      : createAppControlWindowRecorder({ logger: args.logger }),
    screencastRecorder: () => args.getScreencastRecorder?.() ?? null,
    ingestArtifacts: args.ingestArtifacts ?? null,
    resolvePrimaryPrUrl: args.resolvePrimaryPrUrl ?? null,
    resolveLaneName: args.resolveLaneName ?? null,
  });


  const controllerFor = (laneId: string): AppControlLaneController => {
    let controller = controllers.get(laneId);
    if (!controller) {
      controller = createAppControlLaneController({ args, recording, sourceFileCache }, laneId);
      controllers.set(laneId, controller);
    }
    return controller;
  };

  const liveSessions = (): AppControlSession[] =>
    [...controllers.values()]
      .map((controller) => controller.getSession())
      .filter((session): session is AppControlSession => Boolean(session));

  /**
   * The lane a call acts on: the one it names, else the lane of the session id
   * it holds, else its chat's lane. There is no "first lane" fallback: a call
   * that resolves to no lane is refused by `requireLaneId`.
   */
  /** The lane a call names, from what this service already knows. No lookups. */
  const knownLaneId = (ref: AppControlLaneRef | null | undefined): string | null => {
    const explicit = cleanClaimId(ref?.laneId);
    if (explicit) return explicit;
    const sessionId = cleanClaimId(ref?.sessionId);
    if (sessionId) {
      const owner = [...controllers.values()].find((controller) => controller.getSession()?.id === sessionId);
      if (owner) return owner.laneId;
    }
    const chatSessionId = cleanClaimId(ref?.chatSessionId);
    if (chatSessionId) {
      const owned = [...controllers.values()].find((controller) => controller.getSession()?.chatSessionId === chatSessionId);
      if (owned) return owned.laneId;
    }
    return null;
  };

  const resolveCallLaneId = async (
    ref: AppControlLaneRef | null | undefined,
    options: { cwd?: string | null; projectRoot?: string | null } = {},
  ): Promise<string | null> => {
    const known = knownLaneId(ref);
    if (known) return known;
    const chatSessionId = cleanClaimId(ref?.chatSessionId);
    if (chatSessionId) {
      const chatLane = args.resolveChatLaneId
        ? await Promise.resolve(args.resolveChatLaneId(chatSessionId)).catch(() => null)
        : null;
      if (chatLane?.trim()) return chatLane.trim();
    }
    if (options.cwd || (chatSessionId && !args.resolveChatLaneId)) {
      const projectRoot = normalizeProjectRoot(options.projectRoot, args.projectRoot);
      const resolved = await Promise.resolve(args.resolveLaneId?.({
        projectRoot,
        cwd: options.cwd ?? projectRoot,
        laneId: null,
        chatSessionId,
      })).catch(() => null);
      if (resolved?.trim()) return resolved.trim();
    }
    return null;
  };

  const requireLaneId = async (
    ref: AppControlLaneRef | null | undefined,
    action: string,
    options: { cwd?: string | null; projectRoot?: string | null } = {},
  ): Promise<string> => {
    const laneId = await resolveCallLaneId(ref, options);
    if (!laneId) {
      throw new Error(
        `App Control ${action} needs a lane. Pass laneId, or call it from a chat or from inside a lane worktree.`,
      );
    }
    return laneId;
  };

  /** The lane's controller for an action on its session. Refuses a lane with none. */
  const sessionController = async (ref: AppControlLaneRef | null | undefined, action: string): Promise<AppControlLaneController> => {
    const laneId = await requireLaneId(ref, action);
    const controller = controllers.get(laneId);
    if (!controller?.getSession()) {
      throw new Error(`No App Control session on lane ${laneId}. Launch or connect an app first.`);
    }
    return controller;
  };

  /**
   * The lane's session, plus every lane's for user clients. Synchronous, so it
   * resolves the lane only from what the service holds: a named lane, a
   * session id, or a chat that owns a session.
   */
  const getStatus = (ref: AppControlLaneRef = {}): AppControlStatus => {
    const laneId = knownLaneId(ref);
    const activeSession = laneId ? controllers.get(laneId)?.getSession() ?? null : null;
    return {
      platform: process.platform,
      supported: true,
      laneId,
      activeSession,
      // An agent sees its own lane's session only: another lane's app, its
      // port and its chat are not an agent's to read.
      sessions: ref.agentCaller === true ? (activeSession ? [activeSession] : []) : liveSessions(),
      providers: providersFor(activeSession),
    };
  };

  const claim = async (claimArgs: AppControlClaimArgs = {}): Promise<AppControlStatus> => {
    const laneId = await requireLaneId(claimArgs, "claim");
    controllers.get(laneId)?.claim(claimArgs);
    return getStatus({ laneId });
  };

  /**
   * The lane whose live session holds this CDP port, when it is not `laneId`.
   *
   * The debug port is the whole app: whoever connects to it sees every frame
   * and can drive every window. So one lane may never connect to, or launch
   * onto, the port of an app another lane launched or attached — the same
   * rule Apple's device ownership and Mac Desktop's window ownership apply.
   * Ended sessions (stopped, exited, failed) hold nothing.
   */
  const laneHoldingPort = (port: number, laneId: string): string | null => {
    for (const controller of controllers.values()) {
      if (controller.laneId === laneId) continue;
      const session = controller.getSession();
      if (!session || session.cdpPort !== port) continue;
      if (["stopped", "exited", "failed"].includes(session.status)) continue;
      return controller.laneId;
    }
    return null;
  };

  const assertPortFree = (port: number | null, laneId: string, action: string): void => {
    if (!port) return;
    const holder = laneHoldingPort(port, laneId);
    if (!holder) return;
    throw new Error(
      `App Control ${action} refused: CDP port ${port} belongs to lane ${holder}'s App Control session. `
        + "A lane may only view and drive the app it launched or connected. Stop that session from its own lane first.",
    );
  };

  /**
   * Refuses a port whose app another lane's Mac Desktop has parked on its
   * display. The debug port drives that app's windows, which are on the other
   * lane's screen, so the refusal is Mac Desktop's own "owned by another lane".
   * Nothing is read when no Mac Desktop is wired (tests, runtimes without one).
   */
  const assertAppNotOnOtherLanesDesktop = async (port: number | null, laneId: string, action: string): Promise<void> => {
    const lookup = args.macDesktopLaneForProcess;
    if (!port || !lookup) return;
    const pid = await readAppProcessId(port).catch(() => null);
    if (!pid) return;
    const holder = await Promise.resolve(lookup(pid)).catch(() => null);
    if (!holder || holder === laneId) return;
    const error = new Error(
      `${MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE}: App Control ${action} refused: the app on CDP port ${port} is on lane ${holder}'s Mac Desktop. `
        + "A lane cannot view or drive another lane's app. Release it from that lane first.",
    ) as Error & { code: string; laneId: string };
    error.code = MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE;
    error.laneId = holder;
    throw error;
  };

  const launch = async (launchArgs: AppControlLaunchArgs = {}): Promise<AppControlSession> => {
    requireSupportedDriver(launchArgs.driver);
    const projectRoot = normalizeProjectRoot(launchArgs.projectRoot, args.projectRoot);
    const cwd = normalizeCwd(launchArgs.cwd, projectRoot);
    const laneId = await resolveCallLaneId(launchArgs, { cwd, projectRoot });
    if (!laneId) {
      throw new Error("App Control could not resolve a lane for the terminal. Select a lane or pass laneId.");
    }
    const requestedPort = asPositiveInt(launchArgs.debugPort ?? launchArgs.cdpPort);
    assertPortFree(requestedPort, laneId, "launch");
    await assertAppNotOnOtherLanesDesktop(requestedPort, laneId, "launch");
    return await controllerFor(laneId).launch({ ...launchArgs, laneId });
  };

  const connect = async (connectArgs: AppControlConnectArgs): Promise<AppControlSession> => {
    requireSupportedDriver(connectArgs.driver);
    const laneId = await requireLaneId(connectArgs, "connect");
    const port = asPositiveInt(connectArgs.cdpPort);
    assertPortFree(port, laneId, "connect");
    await assertAppNotOnOtherLanesDesktop(port, laneId, "connect");
    return await controllerFor(laneId).connect({ ...connectArgs, laneId });
  };

  /**
   * The lane whose live App Control session runs this process, if any. Mac
   * Desktop asks before it parks a window, so one lane cannot claim another
   * lane's App Control app onto its own screen.
   */
  const laneForAppProcess = async (pid: number): Promise<string | null> => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    for (const controller of controllers.values()) {
      const session = controller.getSession();
      if (!session || ["stopped", "exited", "failed"].includes(session.status)) continue;
      if (session.pid === pid) return controller.laneId;
      const appPid = await controller.resolveAppProcessId().catch(() => null);
      if (appPid === pid) return controller.laneId;
    }
    return null;
  };

  const stop = async (stopArgs: AppControlStopArgs = {}): Promise<{ ok: true; previousSession: AppControlSession | null }> => {
    const laneId = await requireLaneId(stopArgs, "stop");
    const controller = controllers.get(laneId);
    if (!controller) return { ok: true, previousSession: null };
    return await controller.stop(stopArgs);
  };

  /** A chat ended: its recordings file themselves and the sessions it owns stop. */
  const stopForChat = async (chatSessionId: string): Promise<void> => {
    const chatId = chatSessionId?.trim();
    if (!chatId) return;
    await recording.stopForChat(chatId);
    const owned = [...controllers.values()].filter((controller) => {
      const session = controller.getSession();
      return session?.chatSessionId === chatId && !["stopped", "exited", "failed"].includes(session.status);
    });
    await Promise.all(owned.map((controller) => controller.stop({}).catch((error: unknown) => {
      args.logger.debug("app_control.stop_for_chat_failed", {
        laneId: controller.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    })));
  };

  /** A lane was archived or deleted: its session stops and its state is dropped. */
  const stopForLane = async (laneId: string): Promise<void> => {
    const id = laneId?.trim();
    if (!id) return;
    // A start in flight settles first, so the stop below sees it; a start that
    // begins after this point is discarded by forgetLane.
    await recording.settleStart(id);
    const controller = controllers.get(id);
    if (controller?.getSession()) {
      await controller.stop({}).catch((error: unknown) => {
        args.logger.debug("app_control.stop_for_lane_failed", {
          laneId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      await recording.stopForAppClosed(id);
    }
    controller?.dispose();
    controllers.delete(id);
    recording.forgetLane(id);
  };

  const onLane = <T,>(action: string, run: (controller: AppControlLaneController) => Promise<T> | T) =>
    async (ref: AppControlLaneRef = {}): Promise<T> => await run(await sessionController(ref, action));

  const selectPoint = async (point: AppControlInspectPointArgs): Promise<AppControlSelectResult> =>
    await (await sessionController(point, "selectPoint")).selectPoint(point);

  const attachToTarget = async (
    input: string | AppControlAttachToTargetArgs,
    ref: AppControlLaneRef = {},
  ): Promise<AppControlSession> => {
    const targetArgs: AppControlAttachToTargetArgs = typeof input === "string" ? { ...ref, targetId: input } : input;
    return await (await sessionController(targetArgs, "attachToTarget")).attachToTarget(targetArgs.targetId);
  };

  const startRecording = async (recordArgs: AppControlRecordStartArgs = {}): Promise<AppControlRecordingStatus> => {
    const laneId = await requireLaneId(recordArgs, "startRecording");
    return await recording.startRecording(laneId, recordArgs);
  };

  const stopRecording = async (recordArgs: AppControlRecordStopArgs = {}): Promise<AppControlRecordingStatus> => {
    const laneId = await requireLaneId(recordArgs, "stopRecording");
    return await recording.stopRecording(laneId, cleanClaimId(recordArgs.chatSessionId));
  };

  const getRecordingStatus = async (recordArgs: AppControlRecordingStatusArgs = {}): Promise<AppControlRecordingStatus> => {
    const laneId = await requireLaneId(recordArgs, "getRecordingStatus");
    return recording.getStatus(laneId);
  };

  /**
   * One still of the lane's app, filed as proof: Mac Desktop's Save screenshot
   * for App Control. The capture is the agent observation's (a fresh
   * `Page.captureScreenshot`, the last live frame only when that fails), so
   * the pane, the CLI and an agent all file the same picture. Owners and
   * provenance match a Mac Desktop still: lane, calling chat, the lane's PR,
   * `ade-capture`.
   */
  const captureProof = async (proofArgs: AppControlCaptureProofArgs = {}): Promise<AppControlCaptureProofResult> => {
    const controller = await sessionController(proofArgs, "captureProof");
    const laneId = controller.laneId;
    const chatSessionId = cleanClaimId(proofArgs.chatSessionId);
    if (!args.ingestArtifacts) {
      throw new Error("App Control proof is unavailable: this ADE host has no proof store.");
    }
    const shot = await controller.observe({ includeDom: false, includeDiagnostics: false });
    // The page title and the lane, never the launch command.
    const caption = proofArgs.caption?.trim() || appControlProofCaption(
      shot.title?.trim() || await controller.getTargetTitle().catch(() => null),
      await Promise.resolve(args.resolveLaneName?.(laneId)).catch(() => null),
    );
    const owners: ComputerUseArtifactOwner[] = [{ kind: "lane", id: laneId, relation: "attached_to" }];
    if (chatSessionId) owners.push({ kind: "chat_session", id: chatSessionId, relation: "attached_to" });
    const prUrl = (await Promise.resolve(args.resolvePrimaryPrUrl?.(laneId)).catch(() => null))?.trim() || null;
    if (prUrl) owners.push({ kind: "github_pr", id: prUrl, relation: "published_to" });
    let filed: ComputerUseArtifactIngestionResult;
    try {
      filed = await args.ingestArtifacts({
        backend: { name: APP_CONTROL_PROOF_BACKEND_NAME, style: "manual", toolName: "app-control proof" },
        callerRoot: args.projectRoot,
        // ADE wrote this frame just now. A still app gives the same bytes
        // twice, and that is a real capture, not a copied proof.
        provenance: { source: "ade-capture" },
        inputs: [{
          kind: "screenshot",
          title: caption,
          description: caption,
          path: shot.filePath,
          metadata: { width: shot.width, height: shot.height, url: shot.url, pageTitle: shot.title },
        }],
        owners,
      });
    } catch (error) {
      args.logger.warn("app_control.screenshot_proof_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `The screenshot was taken (${shot.filePath}), but it could not be filed as proof: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const filedRecord = filed?.artifacts[0] ?? null;
    const artifactId = filedRecord?.id ?? null;
    if (!artifactId) {
      throw new Error(`The screenshot was taken (${shot.filePath}), but the proof store filed no record.`);
    }
    // The filed copy, not the observation: the scratch file is pruned once filed.
    const filedUri = filedRecord?.uri?.trim() ?? "";
    const filedPath = filedUri && !/^[a-z][a-z0-9+.-]*:\/\//i.test(filedUri)
      ? path.resolve(args.projectRoot, filedUri)
      : shot.filePath;
    return {
      artifactId,
      filePath: filedPath,
      width: shot.width,
      height: shot.height,
      caption,
      laneId,
      chatSessionId,
      artifacts: filed.artifacts,
      links: filed.links,
      ...(filed.warnings?.length ? { warnings: filed.warnings } : {}),
    };
  };

  return {
    getStatus,
    claim,
    launch,
    launchInTerminal: launch,
    connect,
    stop,
    stopForChat,
    stopForLane,
    laneForAppProcess,
    focusWindow: onLane("focusWindow", (controller) => controller.focusWindow()),
    minimizeWindow: onLane("minimizeWindow", (controller) => controller.minimizeWindow()),
    screenshot: onLane("screenshot", (controller) => controller.screenshot()),
    getSnapshot: async (snapshotArgs: AppControlSnapshotArgs = {}): Promise<AppControlSnapshot> =>
      await (await sessionController(snapshotArgs, "getSnapshot")).getSnapshot(snapshotArgs),
    inspectPoint: async (point: AppControlInspectPointArgs): Promise<AppControlInspectResult> =>
      await (await sessionController(point, "inspectPoint")).inspectPoint(point),
    selectPoint,
    click: async (clickArgs: AppControlClickArgs): Promise<{ ok: true }> =>
      await (await sessionController(clickArgs, "click")).click(clickArgs),
    typeText: async (typeArgs: AppControlTypeTextArgs): Promise<{ ok: true }> =>
      await (await sessionController(typeArgs, "typeText")).typeText(typeArgs),
    readTerminal: async (terminalArgs: AppControlLaneRef & { maxBytes?: number | null; since?: number | null } = {}) =>
      await (await sessionController(terminalArgs, "readTerminal")).readTerminal(terminalArgs),
    writeTerminal: async (terminalArgs: AppControlLaneRef & { data?: string | null }): Promise<{ ok: true }> =>
      await (await sessionController(terminalArgs, "writeTerminal")).writeTerminal(terminalArgs),
    signalTerminal: async (
      terminalArgs: AppControlLaneRef & { signal?: "SIGINT" | "SIGTERM" | "SIGKILL" | null } = {},
    ): Promise<{ ok: true }> =>
      (await sessionController(terminalArgs, "signalTerminal")).signalTerminal(terminalArgs),
    getLastSelectedItem: (ref: AppControlLaneRef = {}): AppControlContextItem | null => {
      // Only the named lane's pick: another lane's selection is not this caller's.
      const laneId = cleanClaimId(ref.laneId);
      return laneId ? controllers.get(laneId)?.getLastSelectedItem() ?? null : null;
    },
    dispose: () => {
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
      recording.dispose();
    },
    scroll: async (scrollArgs: AppControlScrollArgs): Promise<{ ok: true }> =>
      await (await sessionController(scrollArgs, "scroll")).scroll(scrollArgs),
    dispatchKey: async (keyArgs: AppControlDispatchKeyArgs): Promise<{ ok: true }> =>
      await (await sessionController(keyArgs, "dispatchKey")).dispatchKey(keyArgs),
    listTargets: async (ref: AppControlLaneRef = {}): Promise<AppControlTarget[]> => {
      const laneId = await resolveCallLaneId(ref);
      const controller = laneId ? controllers.get(laneId) : null;
      return controller ? await controller.listTargets() : [];
    },
    attachToTarget,
    // Agent action model (parity with the built-in browser).
    listDrivers: (ref: AppControlLaneRef = {}): AppControlDriversResult => {
      const laneId = knownLaneId(ref);
      return listDriversFor(laneId ? controllers.get(laneId)?.getSession() ?? null : null);
    },
    observe: async (input: AppControlObservationArgs = {}) =>
      await (await sessionController(input, "observe")).observe(input),
    agentClick: async (input: AppControlAgentClickArgs) =>
      await (await sessionController(input, "agentClick")).agentClick(input),
    agentHover: async (input: AppControlAgentHoverArgs) =>
      await (await sessionController(input, "agentHover")).agentHover(input),
    agentFill: async (input: AppControlAgentFillArgs) =>
      await (await sessionController(input, "agentFill")).agentFill(input),
    agentClear: async (input: AppControlAgentClearArgs) =>
      await (await sessionController(input, "agentClear")).agentClear(input),
    agentType: async (input: AppControlAgentTypeArgs) =>
      await (await sessionController(input, "agentType")).agentType(input),
    agentPress: async (input: AppControlAgentPressArgs) =>
      await (await sessionController(input, "agentPress")).agentPress(input),
    agentScroll: async (input: AppControlAgentScrollArgs) =>
      await (await sessionController(input, "agentScroll")).agentScroll(input),
    agentWait: async (input: AppControlAgentWaitArgs) =>
      await (await sessionController(input, "agentWait")).agentWait(input),
    getTrace: (input: AppControlTraceArgs = {}) => {
      const laneId = knownLaneId(input);
      const controller = laneId ? controllers.get(laneId) : null;
      if (!controller?.getSession()) {
        throw new Error(laneId
          ? `No App Control session on lane ${laneId}. Launch or connect an app first.`
          : "App Control getTrace needs a lane. Pass laneId, or call it from a chat or from inside a lane worktree.");
      }
      return controller.getTrace(input);
    },
    windows: async (input: AppControlSessionTargetArgs = {}): Promise<AppControlWindowsResult> =>
      await (await sessionController(input, "windows")).windows(input),
    switchWindow: async (input: AppControlSwitchWindowArgs): Promise<AppControlWindowsResult> =>
      await (await sessionController(input, "switchWindow")).switchWindow(input),
    // Recording (same contract as Mac Desktop's).
    startRecording,
    stopRecording,
    getRecordingStatus,
    captureProof,
    /**
     * The lane's current picture for a new viewer: the newest screencast
     * frame, or one fresh capture when a still app has sent none. Null with no
     * connected session on the lane.
     */
    getLatestFrame: async (ref: AppControlLaneRef = {}): Promise<AppControlScreencastFrame | null> => {
      const laneId = await resolveCallLaneId(ref);
      const controller = laneId ? controllers.get(laneId) : null;
      return controller ? await controller.getLatestFrame() : null;
    },
  };
}
