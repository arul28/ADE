import { describe, expect, it } from "vitest";
import { buildCreateMissionDraft, resolveLaunchLaneId } from "./CreateMissionDialog";

describe("CreateMissionDialog helpers", () => {
  it("resolves launch lane with explicit draft lane first", () => {
    expect(resolveLaunchLaneId({ draftLaneId: "lane-explicit", defaultLaneId: "lane-default" })).toBe("lane-explicit");
  });

  it("resolves launch lane from default lane when draft lane is blank", () => {
    expect(resolveLaunchLaneId({ draftLaneId: "  ", defaultLaneId: "lane-default" })).toBe("lane-default");
  });

  it("applies mission settings defaults to launch draft", () => {
    const draft = buildCreateMissionDraft({
      plannerProvider: "codex",
      claudePermissionMode: "default",
      claudeDangerouslySkip: false,
      codexSandboxPermissions: "workspace-write",
      codexApprovalMode: "suggest",
      codexConfigPath: "  /tmp/codex.toml  ",
      apiPermissionMode: "edit",
    });

    expect(draft.modelConfig.orchestratorModel.provider).toBe("codex");
    expect(draft.permissionConfig.codex?.approvalMode).toBe("suggest");
    expect(draft.permissionConfig.codex?.configPath).toBe("/tmp/codex.toml");
    expect(draft.permissionConfig.api?.permissionMode).toBe("edit");
  });

  it("handles an empty built-in profile list without throwing", () => {
    const draft = buildCreateMissionDraft(undefined, [] as any);
    expect(draft.modelConfig.intelligenceConfig).toBeUndefined();
    expect(draft.modelConfig.profileId).toBeUndefined();
  });
});
