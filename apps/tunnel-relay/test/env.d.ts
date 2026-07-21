import type { TunnelRelayEnv } from "../src/relay";

declare global {
  namespace Cloudflare {
    interface Env extends TunnelRelayEnv {}
  }
}

export {};
