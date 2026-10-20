import type * as DroidSdkNodeTypes from "@factory/droid-sdk/node";
import type { DroidSdkWorkerInit } from "./droidSdkProtocol";

type DroidSdkTransportFactory = Pick<typeof DroidSdkNodeTypes, "ProcessTransport">;

/**
 * Let the Droid CLI own sign-in when ADE has no Factory API key. Since 0.7.0,
 * the SDK's built-in transport requires that key even though the user's CLI
 * login works. The session/client takes ownership of a connected transport and
 * closes it with the session. A configured API key keeps the SDK's normal path.
 */
export async function cliSignInTransport(
  sdk: DroidSdkTransportFactory,
  init: Pick<DroidSdkWorkerInit, "droidPath" | "laneRoot">,
): Promise<{ transport?: DroidSdkNodeTypes.CreateSessionOptions["transport"] }> {
  if (process.env.FACTORY_API_KEY?.trim()) return {};
  const transport = new sdk.ProcessTransport({
    droidExecPath: init.droidPath,
    cwd: init.laneRoot,
    // ProcessTransport merges this with its host process environment before
    // applying its default SDK environment handling.
    env: { FACTORY_UPSTREAM_CLIENT_TYPE: "sdk" },
  });
  await transport.connect();
  return { transport };
}
