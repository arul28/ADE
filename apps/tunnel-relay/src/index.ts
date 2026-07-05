import { handleRequest, TunnelDurableObject, type TunnelRelayEnv } from "./relay";

export { TunnelDurableObject };

export default {
  fetch(request: Request, env: TunnelRelayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
