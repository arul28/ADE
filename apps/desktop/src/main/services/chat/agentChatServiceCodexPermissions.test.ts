import {
  AgentChatEventEnvelope,
  createAgentChatService,
  createService,
  mapPermissionToCodex,
  mockState,
  path,
  readPersistedChatState,
  tmpRoot,
  waitFor,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("Codex permissions and reasoning", () => {
    it("keeps fast mode switching away from Codex only onto a model with a fast tier", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        fastMode: true,
      });

      const onOpus = await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-opus-5",
      });
      expect(onOpus.provider).toBe("claude");
      expect(onOpus.fastMode).toBe(true);
      expect(readPersistedChatState(session.id).fastMode).toBe(true);

      const onSonnet = await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-sonnet-5",
      });
      expect(onSonnet.fastMode).not.toBe(true);
      expect((await service.getSessionSummary(session.id))?.fastMode).not.toBe(true);
      expect(readPersistedChatState(session.id).fastMode).not.toBe(true);
    });

    it("re-resumes Codex threads when fast mode changes mid-session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Initial standard turn.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: `turn-${mockState.codexTurnCounter}`,
            status: "completed",
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });

      mockState.codexRequestPayloads = [];
      const updated = await service.updateSession({
        sessionId: session.id,
        fastMode: true,
      });
      expect(updated.fastMode).toBe(true);

      await service.sendMessage({
        sessionId: session.id,
        text: "Next turn should re-resume fast.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const resumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      expect((resumeRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
    });

    it("preserves Codex edit sessions as untrusted workspace-write", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      });

      expect(session.permissionMode).toBe("edit");
      expect(session.codexApprovalPolicy).toBe("untrusted");
      expect(session.codexSandbox).toBe("workspace-write");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("edit");
    });

    it("starts Codex full-auto sessions with danger-full-access and never approval", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo and then edit files if needed.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const params = threadStartRequest?.params as {
        approvalPolicy?: unknown;
        sandbox?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
        effort?: unknown;
        config?: { model_reasoning_effort?: unknown };
      } | undefined;
      expect(params?.approvalPolicy).toBe("never");
      expect(params?.sandbox).toBe("danger-full-access");
      expect(params?.config?.model_reasoning_effort).toBe("medium");
      expect(params?.effort).toBeUndefined();
      expect(params?.reasoningEffort).toBeUndefined();
      expect(params?.reasoning_effort).toBeUndefined();

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        effort?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("never");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("dangerFullAccess");
      expect(turnStartParams?.effort).toBe("medium");
      expect(turnStartParams?.reasoningEffort).toBeUndefined();
      expect(turnStartParams?.reasoning_effort).toBeUndefined();
    });

    it("serializes every Codex permission mode to the app-server wire shapes", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        if (mode === "default") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
        if (mode === "config-toml") return null;
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const cases = [
        {
          mode: "plan" as const,
          approvalPolicy: "on-request",
          lifecycleSandbox: "read-only",
          turnSandboxType: "readOnly",
        },
        {
          mode: "default" as const,
          approvalPolicy: "on-request",
          lifecycleSandbox: "workspace-write",
          turnSandboxType: "workspaceWrite",
        },
        {
          mode: "edit" as const,
          approvalPolicy: "untrusted",
          lifecycleSandbox: "workspace-write",
          turnSandboxType: "workspaceWrite",
        },
        {
          mode: "full-auto" as const,
          approvalPolicy: "never",
          lifecycleSandbox: "danger-full-access",
          turnSandboxType: "dangerFullAccess",
        },
        {
          mode: "config-toml" as const,
          approvalPolicy: undefined,
          lifecycleSandbox: undefined,
          turnSandboxType: undefined,
        },
      ];

      for (const scenario of cases) {
        mockState.codexRequestPayloads = [];
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          permissionMode: scenario.mode,
        });

        await service.sendMessage({
          sessionId: session.id,
          text: `Probe ${scenario.mode} permissions.`,
        });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        });

        const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
        const threadParams = threadStartRequest?.params as {
          approvalPolicy?: unknown;
          sandbox?: unknown;
        } | undefined;
        expect(threadParams?.approvalPolicy).toBe(scenario.approvalPolicy);
        expect(threadParams?.sandbox).toBe(scenario.lifecycleSandbox);

        const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
        const turnParams = turnStartRequest?.params as {
          approvalPolicy?: unknown;
          sandboxPolicy?: { type?: unknown };
        } | undefined;
        expect(turnParams?.approvalPolicy).toBe(scenario.approvalPolicy);
        expect(turnParams?.sandboxPolicy?.type).toBe(scenario.turnSandboxType);
      }
    });

    it("keeps the requested Codex reasoning effort while applying effective thread policy", async () => {
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-effective-start" },
        approvalPolicy: "onFailure",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: { type: "fullAccess" },
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        reasoningEffort: "high",
      }));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const threadStartParams = threadStartRequest?.params as {
        config?: { model_reasoning_effort?: unknown };
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
        effort?: unknown;
      } | undefined;
      expect(threadStartParams?.config?.model_reasoning_effort).toBe("xhigh");
      expect(threadStartParams?.effort).toBeUndefined();
      expect(threadStartParams?.reasoningEffort).toBeUndefined();
      expect(threadStartParams?.reasoning_effort).toBeUndefined();
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        effort?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("on-failure");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("workspaceWrite");
      expect(turnStartParams?.effort).toBe("xhigh");
      expect(turnStartParams?.reasoningEffort).toBeUndefined();
      expect(turnStartParams?.reasoning_effort).toBeUndefined();

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.codexApprovalPolicy).toBe("on-failure");
      expect(summary?.codexSandbox).toBe("workspace-write");
      expect(summary?.permissionMode).toBe("default");
      expect(summary?.reasoningEffort).toBe("xhigh");

      const persisted = readPersistedChatState(session.id);
      expect(persisted.codexApprovalPolicy).toBe("on-failure");
      expect(persisted.codexSandbox).toBe("workspace-write");
      expect(persisted.reasoningEffort).toBe("xhigh");
    });

    it("applies fresh Codex thread effective sandbox when it differs from requested flags", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "default") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-effective-start-readonly" },
        approvalPolicy: "onRequest",
        sandbox: "read-only",
      }));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "default",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const threadStartParams = threadStartRequest?.params as { approvalPolicy?: unknown; sandbox?: unknown } | undefined;
      expect(threadStartParams?.approvalPolicy).toBe("on-request");
      expect(threadStartParams?.sandbox).toBe("workspace-write");

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("on-request");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("readOnly");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.codexApprovalPolicy).toBe("on-request");
      expect(summary?.codexSandbox).toBe("read-only");
      expect(summary?.permissionMode).toBe("plan");
    });

    it("re-resumes Codex threads when permission mode changes mid-session", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Read the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      mockState.codexRequestPayloads = [];
      mockState.codexResponseOverrides.set("thread/resume", () => ({
        thread: { id: "thread-after-mode-switch" },
        approvalPolicy: "onRequest",
        sandbox: "read-only",
      }));

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Now make the needed changes.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadResumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      const params = threadResumeRequest?.params as {
        approvalPolicy?: unknown;
        sandbox?: unknown;
        reasoningEffort?: unknown;
        effort?: unknown;
        config?: { model_reasoning_effort?: unknown };
      } | undefined;
      expect(params?.approvalPolicy).toBe("never");
      expect(params?.sandbox).toBe("danger-full-access");
      expect(params?.config?.model_reasoning_effort).toBe("medium");
      expect(params?.effort).toBeUndefined();
      expect(params?.reasoningEffort).toBeUndefined();

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        collaborationMode?: { mode?: unknown };
        effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("never");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("dangerFullAccess");
      expect(turnStartParams?.collaborationMode?.mode).toBe("default");
      expect(turnStartParams?.effort).toBe("medium");
    });

    it("auto-approves pending Codex approvals when switched to full-auto during an active turn", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "edit",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-switch-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-switch-1",
          turnId: "  turn-1  ",
          command: "/bin/zsh -lc 'npm test'",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-switch-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-switch-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              write: [path.join(tmpRoot, "generated.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-switch-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-switch-1"
        )).toBe(true);
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-switch-1")).toMatchObject({
          result: { decision: "accept" },
        });
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-switch-1")).toMatchObject({
          result: {
            permissions: {
              fileSystem: {
                write: [path.join(tmpRoot, "generated.txt")],
              },
            },
            scope: "turn",
          },
        });
        expect(events.some((event) =>
          event.event.type === "pending_input_resolved"
          && event.event.itemId === "cmd-switch-1"
          && event.event.resolution === "accepted"
          && event.event.turnId === "turn-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "pending_input_resolved"
          && event.event.itemId === "perm-switch-1"
          && event.event.resolution === "accepted"
          && event.event.turnId === "turn-1"
        )).toBe(true);
      });

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("full-auto");
      expect(summary?.codexApprovalPolicy).toBe("never");
      expect(summary?.codexSandbox).toBe("danger-full-access");
    });

    it("keeps escaped Codex command and file-change approvals manual in full-auto", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.codexRequestPayloads = [];

      const outsideLane = path.dirname(tmpRoot);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          command: "/bin/zsh -lc 'pwd'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-additional-perms-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-additional-perms-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          command: "/bin/zsh -lc 'cat /tmp/escape.txt'",
          additionalPermissions: {
            fileSystem: {
              read: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-additional-perms-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-additional-perms-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "file-escape-1",
        method: "item/fileChange/requestApproval",
        params: {
          itemId: "file-escape-1",
          turnId: "turn-1",
          grantRoot: outsideLane,
          reason: "Edit outside the lane",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "file-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "file-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              write: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-project-roots-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-project-roots-escape-1",
          turnId: "turn-1",
          cwd: path.join(tmpRoot, "src"),
          permissions: {
            fileSystem: {
              entries: [{
                access: "write",
                path: {
                  type: "special",
                  value: {
                    kind: "project_roots",
                    subpath: "..",
                  },
                },
              }],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-project-roots-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-project-roots-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-project-roots-whole-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-project-roots-whole-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              entries: [{
                access: "write",
                path: {
                  type: "special",
                  value: {
                    kind: "project_roots",
                  },
                },
              }],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-project-roots-whole-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-project-roots-whole-1")).toBeUndefined();
    });

    it("keeps escaped pending Codex approvals manual when switched to full-auto", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "edit",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.codexRequestPayloads = [];

      const outsideLane = path.dirname(tmpRoot);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-pending-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-pending-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          command: "/bin/zsh -lc 'pwd'",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "file-pending-escape-1",
        method: "item/fileChange/requestApproval",
        params: {
          itemId: "file-pending-escape-1",
          turnId: "turn-1",
          grantRoot: outsideLane,
          reason: "Edit outside the lane",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-pending-additional-perms-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-pending-additional-perms-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          command: "/bin/zsh -lc 'cat /tmp/escape.txt'",
          additionalPermissions: {
            fileSystem: {
              read: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-pending-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-pending-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          permissions: {
            fileSystem: {
              write: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-pending-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "file-pending-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-pending-additional-perms-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-pending-escape-1"
        )).toBe(true);
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-pending-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "file-pending-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-pending-additional-perms-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-pending-escape-1")).toBeUndefined();
      expect(events.some((event) =>
        event.event.type === "pending_input_resolved"
        && (
          event.event.itemId === "cmd-pending-escape-1"
          || event.event.itemId === "file-pending-escape-1"
          || event.event.itemId === "cmd-pending-additional-perms-escape-1"
          || event.event.itemId === "perm-pending-escape-1"
        )
      )).toBe(false);

      await service.respondToInput({
        sessionId: session.id,
        itemId: "cmd-pending-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "file-pending-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "cmd-pending-additional-perms-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "perm-pending-escape-1",
        decision: "decline",
      });
    });

    it("keeps Codex planner approval guard scoped to the turn that started in plan mode", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the investigation.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-1",
          },
        },
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-plan-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-plan-1",
          turnId: "turn-1",
          command: "/bin/zsh -lc 'ade --socket lanes list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "error"
          && event.event.turnId === "turn-1"
          && event.event.message.includes("PLANNER CONTRACT VIOLATION")
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-plan-1")).toMatchObject({
        result: { decision: "decline" },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-plan-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-plan-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          reason: "Allow write access",
          permissions: {
            fileSystem: {
              write: [path.join(tmpRoot, "planned-edit.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-plan-1")).toMatchObject({
          result: {
            permissions: {},
            scope: "turn",
          },
        });
      });
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "perm-plan-1"
      )).toBe(false);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({
        sessionId: session.id,
        text: "Now inspect with the updated permissions.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-full-auto-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-full-auto-1",
          turnId: "turn-2",
          command: "/bin/zsh -lc 'ade --socket chat list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-full-auto-1")).toMatchObject({
          result: { decision: "accept" },
        });
      });
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "cmd-full-auto-1"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "error"
        && event.event.turnId === "turn-2"
        && event.event.message.includes("PLANNER CONTRACT VIOLATION")
      )).toBe(false);
    });

    it("carries Codex planner approval guard through async turn/started when turn/start has no id", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      mockState.codexResponseOverrides.set("turn/start", { turn: {} });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the investigation.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {},
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-async-1",
          },
        },
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-plan-async-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-plan-async-1",
          turnId: "turn-async-1",
          command: "/bin/zsh -lc 'ade --socket lanes list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "error"
          && event.event.turnId === "turn-async-1"
          && event.event.message.includes("PLANNER CONTRACT VIOLATION")
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-plan-async-1")).toMatchObject({
        result: { decision: "decline" },
      });
    });

    it("uses each updated Codex reasoning effort on the next post-turn send", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
      });

      const completeLatestTurn = async (): Promise<void> => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            turn: {
              id: `turn-${mockState.codexTurnCounter}`,
              status: "completed",
            },
          },
        });
        await vi.waitFor(async () => {
          expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
        });
      };

      await service.sendMessage({
        sessionId: session.id,
        text: "Initial turn.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      await completeLatestTurn();

      for (const effort of ["low", "medium", "high", "xhigh", "ultra"]) {
        await service.updateSession({
          sessionId: session.id,
          reasoningEffort: effort,
        });
        mockState.codexRequestPayloads = [];

        await service.sendMessage({
          sessionId: session.id,
          text: `Use ${effort} reasoning now.`,
        });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        });
        const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
        expect((turnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe(effort);
        await completeLatestTurn();
      }
    });

    it("applies Codex reasoning effort changes made during an active turn to the next turn", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        reasoningEffort: "low",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start with low reasoning.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const firstTurnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((firstTurnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe("low");

      await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "xhigh",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: `turn-${mockState.codexTurnCounter}`,
            status: "completed",
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });

      mockState.codexRequestPayloads = [];
      await service.sendMessage({
        sessionId: session.id,
        text: "Now use the updated reasoning.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const secondTurnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((secondTurnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe("xhigh");
    });

    it("re-resumes Codex threads when switching from config-toml to full-auto flags", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexConfigSource: "config-toml",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      const startRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const startParams = startRequest?.params as Record<string, unknown> | undefined;
      expect(startParams?.approvalPolicy).toBeUndefined();
      expect(startParams?.sandbox).toBeUndefined();

      const startTurnRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const startTurnParams = startTurnRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: unknown;
      } | undefined;
      expect(startTurnParams?.approvalPolicy).toBeUndefined();
      expect(startTurnParams?.sandboxPolicy).toBeUndefined();

      mockState.codexRequestPayloads = [];

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Now make the needed changes.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
      });

      const resumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      const resumeParams = resumeRequest?.params as { approvalPolicy?: unknown; sandbox?: unknown } | undefined;
      expect(resumeParams?.approvalPolicy).toBe("never");
      expect(resumeParams?.sandbox).toBe("danger-full-access");
    });

    it("does not auto-upgrade default Codex chats into plan mode", async () => {
      mockState.codexCollaborationModes = [{ mode: "plan" }];
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      expect(params?.collaborationMode).toBeUndefined();
    });

    it("falls back to default collaboration mode when plan is not advertised", async () => {
      mockState.codexCollaborationModes = [{ mode: "default" }];
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Ask one planning question before coding.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "collaborationMode/list")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      const collaborationMode = params?.collaborationMode as { mode?: unknown } | undefined;

      expect(collaborationMode?.mode).toBe("default");
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.codexEffectiveCollaborationMode).toBe("default");
      });
      expect(events.some(({ event }) =>
        event.type === "session_meta_updated" && event.codexEffectiveCollaborationMode === "default",
      )).toBe(true);
    });
  });
});
