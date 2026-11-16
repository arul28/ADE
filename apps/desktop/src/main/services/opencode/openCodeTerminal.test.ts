import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import { ADE_OPENCODE_LAUNCH_ENV } from "../../../shared/cliLaunch";
import { attachOpenCodeTerminal } from "./openCodeTerminal";

const mocks = vi.hoisted(() => {
  const session = {
    get: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
  };
  return {
    session,
    release: vi.fn(),
    lease: {
      url: "http://127.0.0.1:43123",
      password: "test-password",
      release: vi.fn(),
      client: { session },
    },
  };
});

vi.mock("./openCodeServer", () => ({
  acquireOpenCodeServer: vi.fn(async () => mocks.lease),
}));

vi.mock("./openCodeSession", () => ({
  applyOpenCodeSessionMode: vi.fn(async () => undefined),
  applyOpenCodeSessionContext: vi.fn(async () => undefined),
  openCodeSessionEnvironment: vi.fn(() => ({})),
  isOpenCodeNotFoundError: vi.fn(() => false),
  isAdeChatOpenCodeSession: vi.fn(() => false),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const intent = JSON.stringify({
  permissionMode: "full-auto",
  model: "opencode-go/deepseek-v4.1-flash",
});
const resumeCommand = `ADE_OPENCODE_LAUNCH='${intent}' opencode --session ses_test`;

function attach(overrides: Partial<Parameters<typeof attachOpenCodeTerminal>[0]> = {}) {
  return attachOpenCodeTerminal({
    directCommand: "opencode",
    directArgs: ["--session", "ses_test"],
    startupCommand: resumeCommand,
    env: { [ADE_OPENCODE_LAUNCH_ENV]: intent },
    cwd: "/tmp/ade-lane",
    laneWorktreePath: "/tmp/ade-lane",
    permissionMode: null,
    model: null,
    reasoningEffort: null,
    sessionActivityGuidance: null,
    projectConfig: {} as never,
    ownerId: "pty_test",
    logger,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.get.mockResolvedValue({ id: "ses_test" });
  mocks.session.create.mockResolvedValue({ id: "ses_test" });
  mocks.session.list.mockResolvedValue({ data: [] });
});

describe("attachOpenCodeTerminal", () => {
  it.each([
    {
      name: "a direct opencode launch",
      directCommand: "opencode",
      directArgs: ["--session", "ses_test"],
      expectedArgs: ["--server", "http://127.0.0.1:43123", "--session", "ses_test"],
    },
    {
      name: "a resume wrapped in a POSIX login shell",
      directCommand: "/bin/bash",
      directArgs: ["--noprofile", "--norc", "-lc", resumeCommand],
      expectedArgs: [
        "--noprofile",
        "--norc",
        "-lc",
        'opencode --server "http://127.0.0.1:43123" --session ses_test',
      ],
    },
  ])("points $name at ADE's server", async ({ directCommand, directArgs, expectedArgs }) => {
    const attached = await attach({ directCommand, directArgs });

    expect(attached?.directArgs).toEqual(expectedArgs);
    expect(attached?.startupCommand).toBe(
      'opencode --server "http://127.0.0.1:43123" --session ses_test',
    );
    expect(attached?.env.OPENCODE_SERVER_PASSWORD).toBe("test-password");
    expect(attached?.env[ADE_OPENCODE_LAUNCH_ENV]).toBeUndefined();
  });
});
