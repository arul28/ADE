import { RepoEventsDurableObject } from "./repoEventsDurableObject";
import { handleRequest, type RelayEnv } from "./relay";

export { RepoEventsDurableObject };

export default {
  async fetch(request: Request, env: RelayEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      // Log the cause and answer with JSON, so clients can show a reason
      // instead of Cloudflare's bare 500 page.
      const message = error instanceof Error ? error.message : String(error);
      console.error("relay.unhandled_error", { path: new URL(request.url).pathname, message });
      return new Response(JSON.stringify({ ok: false, error: "internal_error", reason: message.slice(0, 200) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
