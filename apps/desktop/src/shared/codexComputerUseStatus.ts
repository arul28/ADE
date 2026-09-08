/** ADE injects Computer Use as the `computer_use` Codex MCP server. */
export function isCodexComputerUseServer(serverName: string | null | undefined): boolean {
  const name = (serverName ?? "").trim().toLowerCase().replace(/_/g, "-");
  return name === "computer-use" || name.endsWith("/computer-use");
}

export function shouldEmitCodexComputerUseStatus(platform: NodeJS.Platform | string): boolean {
  return platform === "darwin";
}

export function codexComputerUseStatusLabel(failed: boolean): "ready" | "not set up" {
  return failed ? "not set up" : "ready";
}

/** Live working-row payload, or null when this host must not show Computer Use. */
export function codexComputerUseToolCall(args: {
  platform: NodeJS.Platform | string;
  serverName: string | null | undefined;
  failed: boolean;
}): { tool: "computer_use"; args: { status: "ready" | "not set up" }; itemId: string } | null {
  if (!shouldEmitCodexComputerUseStatus(args.platform)) return null;
  if (!isCodexComputerUseServer(args.serverName)) return null;
  const serverName = (args.serverName ?? "computer_use").trim() || "computer_use";
  return {
    tool: "computer_use",
    args: { status: codexComputerUseStatusLabel(args.failed) },
    itemId: `computer-use:${serverName}`,
  };
}
