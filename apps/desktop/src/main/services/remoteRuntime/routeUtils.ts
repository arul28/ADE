import type { RemoteRuntimeTargetRoute } from "../../../shared/types/remoteRuntime";

export function routeKey(route: Pick<RemoteRuntimeTargetRoute, "hostname" | "port">): string {
  return `${route.hostname.toLowerCase().replace(/\.$/, "")}:${route.port ?? ""}`;
}
