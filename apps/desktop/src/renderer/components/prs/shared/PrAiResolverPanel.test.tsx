/* @vitest-environment jsdom */

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { render } from "@testing-library/react";
import { buildPrAiResolutionContextKey } from "../../../../shared/types/prs";
import type { PrAiResolutionContext, PrAiResolutionSessionInfo } from "../../../../shared/types/prs";
import { AgentChatPane } from "../../chat/AgentChatPane";
import { PrAiResolverPanel } from "./PrAiResolverPanel";

const context: PrAiResolutionContext = {
  sourceTab: "normal",
  laneId: "lane-1",
};
const contextKey = buildPrAiResolutionContextKey(context);
const sessionInfo: PrAiResolutionSessionInfo = {
  contextKey,
  sessionId: "resolver-session",
  provider: "codex",
  model: "codex-resolver",
  modelId: "codex-resolver",
  reasoning: "medium",
  permissionMode: "guarded_edit",
  context,
  status: "running",
};

vi.mock("../../chat/AgentChatPane", () => ({
  AgentChatPane: vi.fn(() => null),
}));

const basePrsValue = {
  resolverSessionsByContextKey: { [contextKey]: sessionInfo },
  activeTab: "normal",
  prs: [],
  lanes: [],
  mergeContextByPrId: {},
  selectedPrId: null,
  selectedQueueGroupId: null,
  selectedRebaseItemId: null,
  mergeMethod: "squash",
  loading: false,
  error: null,
  detailStatus: null,
  detailChecks: [],
  detailReviews: [],
  detailComments: [],
  detailBusy: false,
  rebaseNeeds: [],
  autoRebaseStatuses: [],
  queueStates: {},
  queueRehearsals: {},
  inlineTerminal: null,
  resolverModel: "codex-resolver",
  resolverReasoningLevel: "medium",
  resolverPermissionMode: "guarded_edit",
  setActiveTab: vi.fn(),
  setSelectedPrId: vi.fn(),
  setSelectedQueueGroupId: vi.fn(),
  setSelectedRebaseItemId: vi.fn(),
  setMergeMethod: vi.fn(),
  setResolverModel: vi.fn(),
  setResolverReasoningLevel: vi.fn(),
  setResolverPermissionMode: vi.fn(),
  upsertResolverSession: vi.fn(),
  clearResolverSession: vi.fn(),
  setInlineTerminal: vi.fn(),
  refresh: vi.fn(() => Promise.resolve()),
};

vi.mock("../../prs/state/PrsContext", () => ({
  usePrs: () => basePrsValue,
}));

describe("PrAiResolverPanel shared stack", () => {
  beforeEach(() => {
    (AgentChatPane as unknown as Mock).mockClear();
    globalThis.window.ade = {
      prs: {
        onAiResolutionEvent: vi.fn(() => () => undefined),
        aiResolutionGetSession: vi.fn(() => Promise.resolve(null)),
      },
    } as any;
  });

  it("renders the AgentChatPane with resolver presentation", () => {
    render(
      <PrAiResolverPanel
        title="Resolver"
        description="Resolve a PR"
        context={context}
        modelId="codex-resolver"
        reasoningEffort="medium"
        permissionMode="guarded_edit"
        onModelChange={vi.fn()}
        onPermissionModeChange={vi.fn()}
      />,
    );

    expect(AgentChatPane).toHaveBeenCalled();
    expect(AgentChatPane).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentation: expect.objectContaining({ mode: "resolver" }),
      }),
      expect.anything(),
    );
  });
});
