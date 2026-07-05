import { handleRequest, type PushRelayEnv } from "./relay";

export default {
  fetch(request: Request, env: PushRelayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
