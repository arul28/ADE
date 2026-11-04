/**
 * The cards ADE draws itself in place of a plain question: the private secret
 * card, the connect card and the MCP server card. The composer, the
 * transcript and the chat pane each ask which one a request is; this is the
 * one place that answers, so a new card is added here once.
 */
import { readIntegrationConnectRequestCard, type IntegrationConnectRequestCard } from "./integrationConnect";
import { readMcpServerRequestCard, type McpServerRequestCard } from "./mcpServerRequest";
import { readProjectSecretRequestCard, type ProjectSecretRequestCard } from "./projectSecretRequest";
import type { PendingInputRequest } from "./types/chat";

export type NativeInputCard =
  | { kind: "secret"; card: ProjectSecretRequestCard }
  | { kind: "connect"; card: IntegrationConnectRequestCard }
  | { kind: "mcp-server"; card: McpServerRequestCard };

export function readNativeInputCard(
  request: Pick<PendingInputRequest, "providerMetadata"> | null | undefined,
): NativeInputCard | null {
  if (!request) return null;
  const secret = readProjectSecretRequestCard(request);
  if (secret) return { kind: "secret", card: secret };
  const connect = readIntegrationConnectRequestCard(request);
  if (connect) return { kind: "connect", card: connect };
  const mcpServer = readMcpServerRequestCard(request);
  if (mcpServer) return { kind: "mcp-server", card: mcpServer };
  return null;
}

/**
 * The card shows why its last answer did not go through (a refused key, a
 * failed save) itself, so the chat does not show that error a second time.
 */
export function cardShowsOwnError(card: NativeInputCard | null): boolean {
  return card?.kind === "connect" || card?.kind === "mcp-server";
}
