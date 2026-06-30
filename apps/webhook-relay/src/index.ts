import { handleRequest, type RelayEnv } from "./relay";

export default {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
