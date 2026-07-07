import { describe, expect, it } from "vitest";
import {
  applyUnifiedPermissionToNativeControls,
  buildChatLaunchNativePayload,
  cliPermissionModeFromNativeControls,
  defaultNativeControls,
  readUnifiedPermissionFromNativeControls,
} from "./nativeLaunchControls";

describe("nativeLaunchControls", () => {
  it("maps plan mode onto codex native fields", () => {
    const controls = applyUnifiedPermissionToNativeControls(
      "openai/gpt-5.5",
      "plan",
      defaultNativeControls(),
    );
    expect(controls.codexApprovalPolicy).toBe("on-request");
    expect(controls.codexSandbox).toBe("read-only");
    const payload = buildChatLaunchNativePayload("openai/gpt-5.5", controls);
    expect(payload.permissionMode).toBe("plan");
  });

  it("maps plan mode onto cursor native fields", () => {
    const controls = applyUnifiedPermissionToNativeControls(
      "cursor/composer-2.5",
      "plan",
      defaultNativeControls(),
    );
    expect(controls.cursorModeId).toBe("plan");
    expect(cliPermissionModeFromNativeControls("cursor/composer-2.5", controls)).toBe("plan");
  });

  it("reads unified permission from default native controls", () => {
    const defaults = defaultNativeControls();
    expect(readUnifiedPermissionFromNativeControls("openai/gpt-5.5", defaults)).toBe("default");
    expect(readUnifiedPermissionFromNativeControls("anthropic/claude-opus-4-8", defaults)).toBe("default");
  });
});
