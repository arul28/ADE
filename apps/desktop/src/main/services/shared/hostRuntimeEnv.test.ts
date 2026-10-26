import { describe, expect, it } from "vitest";
import { stripHostRuntimeEnv } from "./hostRuntimeEnv";

describe("stripHostRuntimeEnv", () => {
  it.each([
    {
      name: "a brain started from a tmux pane",
      host: { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%3", TMUX_TMPDIR: "/tmp" },
      dropped: ["TMUX", "TMUX_PANE"],
      kept: { TMUX_TMPDIR: "/tmp" },
    },
    {
      name: "a brain started inside GNU screen",
      host: { STY: "4242.pts-0.mac", WINDOW: "2" },
      dropped: ["STY", "WINDOW"],
      kept: {},
    },
    {
      name: "a WINDOW that is not screen's",
      host: { WINDOW: "main" },
      dropped: [],
      kept: { WINDOW: "main" },
    },
    {
      name: "a brain started inside Zellij",
      host: { ZELLIJ: "0", ZELLIJ_SESSION_NAME: "work", ZELLIJ_PANE_ID: "1", ZELLIJ_CONFIG_DIR: "/cfg" },
      dropped: ["ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"],
      kept: { ZELLIJ_CONFIG_DIR: "/cfg" },
    },
    {
      name: "the brain's own host keys",
      host: { ELECTRON_RUN_AS_NODE: "1", ADE_DEFAULT_ROLE: "cto" },
      dropped: ["ELECTRON_RUN_AS_NODE", "ADE_DEFAULT_ROLE"],
      kept: {},
    },
  ])("keeps $name out of the programs it starts", ({ host, dropped, kept }) => {
    const hostEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", ...host };
    const env = stripHostRuntimeEnv({ ...hostEnv }, hostEnv);

    for (const key of dropped) expect(env, key).not.toHaveProperty(key);
    expect(env).toMatchObject({ PATH: "/usr/bin", ...kept });
  });

  it("keeps a value the caller set on purpose", () => {
    const hostEnv: NodeJS.ProcessEnv = { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%3" };
    // A lane or a launch that names its own tmux session keeps it.
    const env = stripHostRuntimeEnv({ ...hostEnv, TMUX: "/tmp/tmux-501/lane,9,0" }, hostEnv);

    expect(env.TMUX).toBe("/tmp/tmux-501/lane,9,0");
    expect(env).not.toHaveProperty("TMUX_PANE");
  });
});
