import { RepoEventsDurableObject } from "./repoEventsDurableObject";
import { handleRequest, type RelayEnv } from "./relay";

export { RepoEventsDurableObject };

export default {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
