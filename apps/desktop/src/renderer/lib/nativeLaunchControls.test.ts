import { describe, expect, it } from "vitest";
import {
  applyUnifiedPermissionToNativeControls,
  buildChatLaunchNativePayload,
  cliPermissionModeFromNativeControls,
  defaultNativeControls,
  readUnifiedPermissionFromNativeControls,
  summarizeNativeControls,
} from "./nativeLaunchControls";

describe("nativeLaunchControls", () => {
  // Pi's native permission field is `permissionMode`; it has no provider
  // sibling, and the main process deletes `opencodePermissionMode` from a Pi
  // session. Falling through to the OpenCode tail wrote back a field the
  // session never carries, silently downgrading a full-auto Pi chat to edit
  // on the first composer interaction.
  it("summarizes a Pi session onto permissionMode alone", () => {
    const controls = { ...defaultNativeControls(), opencodePermissionMode: "full-auto" as const };
    const summary = summarizeNativeControls("pi", controls);

    expect(summary.permissionMode).toBe("full-auto");
    expect(summary.opencodePermissionMode).toBeUndefined();
    expect(summary.droidPermissionMode).toBeUndefined();
    expect(summary.claudePermissionMode).toBeUndefined();
  });

  it("keeps OpenCode carrying both its native field and the legacy mode", () => {
    const controls = { ...defaultNativeControls(), opencodePermissionMode: "full-auto" as const };
    const summary = summarizeNativeControls("opencode", controls);

    expect(summary.opencodePermissionMode).toBe("full-auto");
    expect(summary.permissionMode).toBe("full-auto");
  });

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

  it("keeps legacy edit on writable Cursor Agent instead of read-only Ask", () => {
    const controls = applyUnifiedPermissionToNativeControls(
      "cursor/composer-2.5",
      "edit",
      defaultNativeControls(),
    );
    expect(controls.cursorModeId).toBe("agent");
  });

  it("reads unified permission from default native controls", () => {
    const defaults = defaultNativeControls();
    expect(readUnifiedPermissionFromNativeControls("openai/gpt-5.5", defaults)).toBe("default");
    expect(readUnifiedPermissionFromNativeControls("anthropic/claude-opus-4-8", defaults)).toBe("default");
  });
});
