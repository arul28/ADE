/**
 * MCP client integration stub.
 * When @ai-sdk/mcp is installed, this module will bridge MCP servers
 * into the Vercel AI SDK tool format.
 */
export async function loadMcpTools(
  _mcpConfig?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // Stub: MCP tool integration will be added when @ai-sdk/mcp is installed.
  // For now, return an empty tool set.
  return {};
}
