import { describe, expect, it } from "vitest";
import type { LocalRuntimeStatus, UpdateImpact } from "../../../shared/types";
import { decideInstallOnQuit } from "./installOnQuit";

const idle: UpdateImpact = { checked: true, chats: [], cliSessions: 0, terminals: 0 };
const chat = { sessionId: "s1", title: "Fix the build", projectName: "ade" };

describe("decideInstallOnQuit", () => {
  // A quit leaves the background brain running its agents; an install restarts
  // it. So a quit installs only when that stops nothing, and "could not check"
  // never reads as idle.
  it.each([
    { label: "an idle service brain", runtimeMode: "primary", impact: idle, expected: { action: "install" } },
    { label: "a chat mid-turn", runtimeMode: "primary", impact: { ...idle, chats: [chat] }, expected: { action: "defer", reason: "agents_running" } },
    { label: "a CLI session", runtimeMode: "primary", impact: { ...idle, cliSessions: 1 }, expected: { action: "defer", reason: "agents_running" } },
    { label: "a terminal", runtimeMode: "primary", impact: { ...idle, terminals: 2 }, expected: { action: "defer", reason: "agents_running" } },
    { label: "an older brain that is busy without detail", runtimeMode: "primary", impact: { ...idle, busyWithoutDetail: true }, expected: { action: "defer", reason: "agents_running" } },
    { label: "a probe that timed out", runtimeMode: "primary", impact: { ...idle, checked: false }, expected: { action: "defer", reason: "work_unknown" } },
    { label: "no probe at all", runtimeMode: "primary", impact: null, expected: { action: "defer", reason: "work_unknown" } },
    { label: "an isolated brain beside a service it cannot see", runtimeMode: "isolated", impact: idle, expected: { action: "defer", reason: "work_unknown" } },
    { label: "ADE running the brain itself", runtimeMode: "app_fallback", impact: { ...idle, chats: [chat] }, expected: { action: "install" } },
  ] as Array<{ label: string; runtimeMode: LocalRuntimeStatus["runtimeMode"]; impact: UpdateImpact | null; expected: Record<string, string> }>)("$label", ({ runtimeMode, impact, expected }) => {
    expect(decideInstallOnQuit({ version: "1.2.126", runtimeMode, impact })).toEqual({ version: "1.2.126", ...expected });
  });
});
