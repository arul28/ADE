import { RepoEventsDurableObject } from "./repoEventsDurableObject";
import { handleRequest, type RelayEnv } from "./relay";

export { RepoEventsDurableObject };

export default {
  async fetch(request: Request, env: RelayEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      // Log the cause and answer with JSON instead of Cloudflare's bare 500
      // page. The message stays in the log: it can name config or D1 details.
      const message = error instanceof Error ? error.message : String(error);
      console.error("relay.unhandled_error", { path: new URL(request.url).pathname, message });
      return new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
