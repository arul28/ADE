import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type { GithubDirectClientState, GithubDirectRequest, GithubDirectRequestOptions, GithubDirectResult } from "../../../shared/types";
import type { AccountAppTokenClient } from "../../../shared/github/accountAppTokenClient";
import { accountAppDirectCredential, createGithubDirectClient } from "../../../shared/github/directClient";
import { isTrustedAdeRendererSender } from "../ipc/trustedRendererSender";
import { acquireGithubRequestSlot } from "./githubRequestGate";

/**
 * `window.ade.githubDirect`: GitHub reads with the ADE account's GitHub App
 * sign-in, sent from this window's main process straight to api.github.com.
 *
 * These calls take no machine pin, on purpose. They read GitHub with the
 * account's own sign-in, which every device of the account shares; no ADE
 * machine, lane or clone is involved, so they work with zero machines
 * online. The token stays in this process (the renderer never holds it),
 * and the renderer can only ask for the reads `buildGithubDirectRequest`
 * allows, with checked arguments. Lane-linked data (lane ↔ PR links, chat
 * cards) stays on the machine path with its pin.
 *
 * Requests share the process's six-slot GitHub gate with the machine path.
 */
export function registerGithubDirectIpc(args: {
  tokenClient: AccountAppTokenClient;
  getAccountUserId: () => string | null;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}): void {
  const client = createGithubDirectClient({
    credential: accountAppDirectCredential(args.tokenClient, args.getAccountUserId),
    acquireSlot: acquireGithubRequestSlot,
  });

  ipcMain.handle(IPC.githubDirectRequest, async (event, request: unknown, options: unknown): Promise<GithubDirectResult<unknown>> => {
    if (!isTrustedAdeRendererSender(event)) throw new Error("GitHub reads are only available to the ADE window.");
    const requestOptions: GithubDirectRequestOptions = {
      background: Boolean(options && typeof options === "object" && (options as { background?: unknown }).background === true),
    };
    const result = await client.request(request as GithubDirectRequest, requestOptions);
    if (!result.ok && result.error.kind === "github_unavailable") {
      const op = (request as { op?: unknown } | null)?.op;
      args.logger.warn("github.direct_read_unavailable", { op: typeof op === "string" ? op.slice(0, 40) : null });
    }
    return result;
  });

  ipcMain.handle(IPC.githubDirectGetState, async (event): Promise<GithubDirectClientState> => {
    if (!isTrustedAdeRendererSender(event)) throw new Error("GitHub reads are only available to the ADE window.");
    return client.state();
  });
}
