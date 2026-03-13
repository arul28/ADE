import http from "node:http";
import type {
  ProxyRoute,
  ProxyStatus,
  ProxyConfig,
  LanePreviewInfo,
  LaneProxyEvent,
} from "../../../shared/types";

import type { Logger } from "../logging/logger";

/** A request interceptor that returns true if it handled the request. */
export type ProxyRequestInterceptor = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => boolean;

const DEFAULT_CONFIG: ProxyConfig = {
  proxyPort: 8080,
  hostnameSuffix: ".localhost",
};

/**
 * Per-Lane Hostname Isolation & Preview Service (Phase 5 W4).
 *
 * Runs a *.localhost reverse proxy on a single port, routing requests
 * by Host header to the correct lane's dev server. Each lane gets a
 * unique hostname (<lane-slug>.localhost) providing automatic cookie/auth
 * isolation — no cross-lane session leakage.
 */
export function createLaneProxyService({
  logger,
  config: userConfig,
  broadcastEvent,
}: {
  logger: Logger;
  config?: Partial<ProxyConfig>;
  broadcastEvent: (ev: LaneProxyEvent) => void;
}) {
  const cfg: ProxyConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const routes = new Map<string, ProxyRoute>();
  const interceptors: ProxyRequestInterceptor[] = [];
  let server: http.Server | null = null;
  let startedAt: string | undefined;
  let startPromise: Promise<ProxyStatus> | null = null;

  // --- helpers ---------------------------------------------------------------

  /** Convert a lane name/id to a URL-safe slug for hostname use. */
  function toLaneSlug(laneId: string, laneName?: string): string {
    const raw = laneName ?? laneId;
    return raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lane";
  }

  function buildHostnameFromSlug(slug: string): string {
    return `${slug}${cfg.hostnameSuffix}`;
  }

  function findRouteByHostname(hostname: string, excludeLaneId?: string): ProxyRoute | null {
    for (const route of routes.values()) {
      if (route.laneId === excludeLaneId) continue;
      if (route.hostname === hostname && route.status === "active") {
        return route;
      }
    }
    return null;
  }

  /** Build a collision-safe hostname for a lane (e.g. "my-feature.localhost"). */
  function buildHostname(laneId: string, laneName?: string): string {
    const preferredSlug = toLaneSlug(laneId, laneName);
    const preferredHostname = buildHostnameFromSlug(preferredSlug);
    if (!findRouteByHostname(preferredHostname, laneId)) return preferredHostname;

    const laneIdSlug = toLaneSlug(laneId);
    const base = preferredSlug === laneIdSlug ? `${preferredSlug}-lane` : `${preferredSlug}-${laneIdSlug}`;

    let candidate = buildHostnameFromSlug(base);
    let suffix = 2;
    while (findRouteByHostname(candidate, laneId)) {
      candidate = buildHostnameFromSlug(`${base}-${suffix}`);
      suffix += 1;
    }
    return candidate;
  }

  /** Build the preview URL for a lane. */
  function buildPreviewUrl(hostname: string): string {
    return `http://${hostname}:${cfg.proxyPort}`;
  }

  /** Resolve a Host header value to a route. */
  function resolveRoute(hostHeader: string): ProxyRoute | null {
    const trimmed = hostHeader.trim();
    const hostname = trimmed.startsWith("[")
      ? trimmed.slice(1, trimmed.indexOf("]")).toLowerCase()
      : trimmed.split(":")[0].toLowerCase();
    return findRouteByHostname(hostname);
  }

  /** Build a snapshot of the current proxy status. */
  function buildStatus(): ProxyStatus {
    return {
      running: server !== null && server.listening,
      proxyPort: cfg.proxyPort,
      routes: Array.from(routes.values()),
      startedAt,
    };
  }

  /** Forward an HTTP request to a target port. */
  function proxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetPort: number
  ): void {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        "x-forwarded-host": req.headers.host,
        "x-forwarded-port": String(cfg.proxyPort),
        "x-forwarded-proto": "http",
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      logger.warn("lane_proxy.upstream_error", {
        targetPort,
        error: err.message,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end(`Proxy error: upstream at port ${targetPort} unreachable`);
    });

    req.pipe(proxyReq, { end: true });
  }

  /** Handle an incoming HTTP request on the proxy port. */
  function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // Check interceptors first (e.g. OAuth redirect handler)
    for (const fn of interceptors) {
      try {
        if (fn(req, res)) return;
      } catch (error) {
        logger.error("lane_proxy.interceptor_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        res.end("Proxy interceptor error");
        return;
      }
    }

    const host = req.headers.host;
    if (!host) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing Host header");
      return;
    }

    const route = resolveRoute(host);
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`No route for hostname: ${host.split(":")[0]}`);
      return;
    }

    logger.debug("lane_proxy.routing", {
      host,
      laneId: route.laneId,
      targetPort: route.targetPort,
    });

    proxyRequest(req, res, route.targetPort);
  }

  // --- public API ------------------------------------------------------------

  return {
    /**
     * Start the reverse proxy server.
     * Resolves once the server is listening.
     */
    async start(port?: number): Promise<ProxyStatus> {
      if (server?.listening) {
        logger.debug("lane_proxy.already_running", { port: cfg.proxyPort });
        return buildStatus();
      }

      if (startPromise) {
        logger.debug("lane_proxy.start_inflight");
        return startPromise;
      }

      const requestedPort = port ?? cfg.proxyPort;

      const finalizeStartFailure = (error: NodeJS.ErrnoException): never => {
        logger.error("lane_proxy.server_error", {
          error: error.message,
          code: error.code,
          port: requestedPort,
        });
        const status: ProxyStatus = {
          ...buildStatus(),
          running: false,
          error: error.message,
        };
        broadcastEvent({ type: "proxy-stopped", status, error: error.message });
        throw error;
      };

      const listenOnce = (listenPort: number): Promise<ProxyStatus> =>
        new Promise((resolve, reject) => {
          const srv = http.createServer(handleRequest);
          let settled = false;

          const rejectStart = (error: NodeJS.ErrnoException) => {
            if (settled) return;
            settled = true;
            srv.removeAllListeners();
            try {
              srv.close();
            } catch {
              // no-op: server may not have started listening yet
            }
            reject(error);
          };

          srv.once("error", (error: NodeJS.ErrnoException) => {
            rejectStart(error);
          });

          srv.listen(listenPort, "127.0.0.1", () => {
            if (settled) return;
            settled = true;
            server = srv;
            const addr = srv.address();
            if (typeof addr === "object" && addr) {
              cfg.proxyPort = addr.port;
            } else {
              cfg.proxyPort = listenPort;
            }
            startedAt = new Date().toISOString();
            const status = buildStatus();
            broadcastEvent({ type: "proxy-started", status });
            logger.info("lane_proxy.started", { port: cfg.proxyPort, requestedPort: listenPort });
            resolve(status);
          });
        });

      startPromise = (async () => {
        try {
          try {
            return await listenOnce(requestedPort);
          } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === "EADDRINUSE" && requestedPort !== 0) {
              logger.warn("lane_proxy.port_in_use_fallback", {
                requestedPort,
                fallback: "ephemeral",
              });
              return await listenOnce(0);
            }
            return finalizeStartFailure(err);
          }
        } finally {
          startPromise = null;
        }
      })();

      return startPromise;
    },

    /**
     * Stop the reverse proxy server.
     */
    async stop(): Promise<void> {
      if (!server) return;

      return new Promise((resolve) => {
        server!.close(() => {
          server = null;
          startedAt = undefined;
          startPromise = null;
          const status = buildStatus();
          broadcastEvent({ type: "proxy-stopped", status });
          logger.info("lane_proxy.stopped");
          resolve();
        });
      });
    },

    /**
     * Add or update a proxy route for a lane.
     */
    addRoute(laneId: string, targetPort: number, laneName?: string): ProxyRoute {
      const hostname = buildHostname(laneId, laneName);

      const route: ProxyRoute = {
        laneId,
        hostname,
        targetPort,
        status: "active",
        createdAt: new Date().toISOString(),
      };

      routes.set(laneId, route);
      broadcastEvent({ type: "route-added", route, status: buildStatus() });
      logger.info("lane_proxy.route_added", { laneId, hostname, targetPort });
      return route;
    },

    /**
     * Remove the proxy route for a lane.
     */
    removeRoute(laneId: string): void {
      const route = routes.get(laneId);
      if (!route) {
        logger.warn("lane_proxy.route_not_found", { laneId });
        return;
      }

      routes.delete(laneId);
      broadcastEvent({ type: "route-removed", route, status: buildStatus() });
      logger.info("lane_proxy.route_removed", { laneId, hostname: route.hostname });
    },

    /**
     * Get the proxy route for a specific lane.
     */
    getRoute(laneId: string): ProxyRoute | null {
      return routes.get(laneId) ?? null;
    },

    /**
     * Get preview info for a lane (URL, hostname, status).
     */
    getPreviewInfo(laneId: string): LanePreviewInfo | null {
      const route = routes.get(laneId);
      if (!route) return null;

      return {
        laneId,
        hostname: route.hostname,
        previewUrl: buildPreviewUrl(route.hostname),
        proxyPort: cfg.proxyPort,
        targetPort: route.targetPort,
        active: route.status === "active" && (server?.listening ?? false),
      };
    },

    /**
     * Generate a preview URL for a lane without requiring an existing route.
     * Useful for displaying a URL before the proxy route is actually created.
     */
    generatePreviewUrl(laneId: string, laneName?: string): string {
      const hostname = buildHostname(laneId, laneName);
      return buildPreviewUrl(hostname);
    },

    /**
     * Generate hostname for a lane from its name/id.
     */
    generateHostname(laneId: string, laneName?: string): string {
      return buildHostname(laneId, laneName);
    },

    /**
     * Get the current proxy server status.
     */
    getStatus(): ProxyStatus {
      return buildStatus();
    },

    /**
     * Get current proxy config.
     */
    getConfig(): ProxyConfig {
      return { ...cfg };
    },

    /**
     * List all registered routes.
     */
    listRoutes(): ProxyRoute[] {
      return Array.from(routes.values());
    },

    /**
     * Resolve a Host header to a route (exported for testing).
     */
    resolveHost(hostHeader: string): ProxyRoute | null {
      return resolveRoute(hostHeader);
    },

    /**
     * Register a request interceptor. Returns an unsubscribe function.
     * Interceptors run before normal hostname routing — return true to
     * indicate the request was handled.
     */
    registerInterceptor(fn: ProxyRequestInterceptor): () => void {
      interceptors.push(fn);
      return () => {
        const idx = interceptors.indexOf(fn);
        if (idx >= 0) interceptors.splice(idx, 1);
      };
    },

    /**
     * Forward an HTTP request to a specific target port.
     * Exposed so interceptors (e.g. OAuth redirect) can reuse the proxy logic.
     */
    forwardToPort(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      targetPort: number,
    ): void {
      proxyRequest(req, res, targetPort);
    },

    /**
     * Dispose service — stop server and clear all state.
     */
    async dispose(): Promise<void> {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
      startPromise = null;
      routes.clear();
      interceptors.length = 0;
      startedAt = undefined;
    },
  };
}
