import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { createLaneProxyService } from "./laneProxyService";
import type { LaneProxyEvent } from "../../../shared/types";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

describe("laneProxyService", () => {
  let events: LaneProxyEvent[];
  let svc: ReturnType<typeof createLaneProxyService>;

  beforeEach(() => {
    events = [];
    svc = createLaneProxyService({
      logger: createLogger(),
      config: { proxyPort: 0, hostnameSuffix: ".localhost" },
      broadcastEvent: (ev) => events.push(ev),
    });
  });

  afterEach(async () => {
    await svc.dispose();
  });

  describe("hostname generation", () => {
    it("generates a slug from lane name", () => {
      const hostname = svc.generateHostname("lane-1", "My Feature Branch");
      expect(hostname).toBe("my-feature-branch.localhost");
    });

    it("falls back to laneId when no name provided", () => {
      const hostname = svc.generateHostname("lane-abc-123");
      expect(hostname).toBe("lane-abc-123.localhost");
    });

    it("sanitizes special characters in lane name", () => {
      const hostname = svc.generateHostname("x", "Hello World! @#$%");
      expect(hostname).toBe("hello-world.localhost");
    });

    it("handles empty lane name by using fallback", () => {
      const hostname = svc.generateHostname("x", "   ");
      expect(hostname).toBe("lane.localhost");
    });

    it("produces unique hostnames for different lanes", () => {
      const h1 = svc.generateHostname("a", "feature-a");
      const h2 = svc.generateHostname("b", "feature-b");
      expect(h1).not.toBe(h2);
    });

    it("disambiguates colliding hostnames for different lanes", () => {
      const routeA = svc.addRoute("lane-1", 3000, "Feature A");
      const routeB = svc.addRoute("lane-2", 3100, "Feature A!!");

      expect(routeA.hostname).toBe("feature-a.localhost");
      expect(routeB.hostname).toBe("feature-a-lane-2.localhost");
      expect(routeB.hostname).not.toBe(routeA.hostname);
    });
  });

  describe("preview URL generation", () => {
    it("generates a preview URL with hostname and proxy port", () => {
      const url = svc.generatePreviewUrl("lane-1", "my-feature");
      expect(url).toMatch(/^http:\/\/my-feature\.localhost:\d+$/);
    });

    it("getPreviewInfo returns null for unregistered lanes", () => {
      const info = svc.getPreviewInfo("nonexistent");
      expect(info).toBeNull();
    });

    it("getPreviewInfo returns info after route is added", () => {
      svc.addRoute("lane-1", 3000, "my-feature");
      const info = svc.getPreviewInfo("lane-1");
      expect(info).not.toBeNull();
      expect(info!.laneId).toBe("lane-1");
      expect(info!.hostname).toBe("my-feature.localhost");
      expect(info!.targetPort).toBe(3000);
      expect(info!.previewUrl).toContain("my-feature.localhost");
    });
  });

  describe("route management", () => {
    it("adds a route and broadcasts event", () => {
      const route = svc.addRoute("lane-1", 3000, "feature-a");
      expect(route.laneId).toBe("lane-1");
      expect(route.hostname).toBe("feature-a.localhost");
      expect(route.targetPort).toBe(3000);
      expect(route.status).toBe("active");

      const addedEvent = events.find((e) => e.type === "route-added");
      expect(addedEvent).toBeTruthy();
      expect(addedEvent!.route!.laneId).toBe("lane-1");
    });

    it("removes a route and broadcasts event", () => {
      svc.addRoute("lane-1", 3000, "feature-a");
      events.length = 0;

      svc.removeRoute("lane-1");
      expect(svc.getRoute("lane-1")).toBeNull();

      const removedEvent = events.find((e) => e.type === "route-removed");
      expect(removedEvent).toBeTruthy();
    });

    it("removing nonexistent route is a no-op", () => {
      svc.removeRoute("nonexistent");
      expect(events.filter((e) => e.type === "route-removed")).toHaveLength(0);
    });

    it("updates route when adding same laneId again", () => {
      svc.addRoute("lane-1", 3000, "old-name");
      svc.addRoute("lane-1", 4000, "new-name");

      const route = svc.getRoute("lane-1");
      expect(route!.targetPort).toBe(4000);
      expect(route!.hostname).toBe("new-name.localhost");
    });

    it("lists all routes", () => {
      svc.addRoute("lane-1", 3000, "a");
      svc.addRoute("lane-2", 3100, "b");
      const routes = svc.listRoutes();
      expect(routes).toHaveLength(2);
    });
  });

  describe("hostname routing (resolveHost)", () => {
    it("resolves hostname to correct route", () => {
      svc.addRoute("lane-1", 3000, "feature-a");
      svc.addRoute("lane-2", 3100, "feature-b");

      const r1 = svc.resolveHost("feature-a.localhost:8080");
      expect(r1!.laneId).toBe("lane-1");
      expect(r1!.targetPort).toBe(3000);

      const r2 = svc.resolveHost("feature-b.localhost:8080");
      expect(r2!.laneId).toBe("lane-2");
      expect(r2!.targetPort).toBe(3100);
    });

    it("resolves hostname without port", () => {
      svc.addRoute("lane-1", 3000, "feature-a");
      const r = svc.resolveHost("feature-a.localhost");
      expect(r!.laneId).toBe("lane-1");
    });

    it("returns null for unknown hostname", () => {
      svc.addRoute("lane-1", 3000, "feature-a");
      const r = svc.resolveHost("unknown.localhost:8080");
      expect(r).toBeNull();
    });

    it("is case-insensitive for hostname matching", () => {
      svc.addRoute("lane-1", 3000, "feature-a");
      const r = svc.resolveHost("Feature-A.localhost:8080");
      expect(r!.laneId).toBe("lane-1");
    });
  });

  describe("cookie isolation", () => {
    it("each lane gets a unique hostname ensuring separate cookie domains", () => {
      svc.addRoute("lane-1", 3000, "feature-alpha");
      svc.addRoute("lane-2", 3100, "feature-beta");
      svc.addRoute("lane-3", 3200, "feature-gamma");

      const r1 = svc.getRoute("lane-1")!;
      const r2 = svc.getRoute("lane-2")!;
      const r3 = svc.getRoute("lane-3")!;

      // All hostnames must be unique
      const hostnames = [r1.hostname, r2.hostname, r3.hostname];
      const unique = new Set(hostnames);
      expect(unique.size).toBe(3);

      // Each hostname ends with the configured suffix
      for (const h of hostnames) {
        expect(h).toMatch(/\.localhost$/);
      }
    });

    it("cookies set on one lane hostname are not sent to another", () => {
      // This is guaranteed by browser cookie domain scoping:
      // Cookies set for "feature-alpha.localhost" will NOT be sent
      // to "feature-beta.localhost" because they're different hostnames.
      // We verify the hostnames are truly distinct.
      svc.addRoute("lane-1", 3000, "feature-alpha");
      svc.addRoute("lane-2", 3100, "feature-beta");

      const h1 = svc.getRoute("lane-1")!.hostname;
      const h2 = svc.getRoute("lane-2")!.hostname;

      expect(h1).not.toBe(h2);
      // Verify they don't share a common subdomain prefix that
      // could allow cookie sharing via domain= attribute
      expect(h1.split(".")[0]).not.toBe(h2.split(".")[0]);
    });
  });

  describe("proxy server lifecycle", () => {
    it("starts and stops the proxy server", async () => {
      const status = await svc.start(0); // port 0 = OS picks a free port
      expect(status.running).toBe(true);
      expect(status.startedAt).toBeTruthy();

      const startEvent = events.find((e) => e.type === "proxy-started");
      expect(startEvent).toBeTruthy();

      await svc.stop();
      const stopEvent = events.find((e) => e.type === "proxy-stopped");
      expect(stopEvent).toBeTruthy();

      const finalStatus = svc.getStatus();
      expect(finalStatus.running).toBe(false);
    });

    it("starting when already running returns current status", async () => {
      await svc.start(0);
      const status2 = await svc.start(0);
      expect(status2.running).toBe(true);
      await svc.stop();
    });

    it("stopping when not running is a no-op", async () => {
      await svc.stop(); // Should not throw
    });

    it("getStatus returns correct state when not running", () => {
      const status = svc.getStatus();
      expect(status.running).toBe(false);
      expect(status.routes).toHaveLength(0);
    });
  });

  describe("E2E proxy routing", () => {
    let targetServer: http.Server;
    let targetPort: number;

    const requestProxy = async (
      proxyPort: number,
      host: string,
      path = "/",
    ): Promise<{ status: number; body: string }> =>
      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: proxyPort,
            path,
            method: "GET",
            headers: { Host: host },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          }
        );
        req.on("error", reject);
        req.end();
      });

    beforeEach(async () => {
      // Start a simple target server
      targetServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            path: req.url,
            host: req.headers.host,
            forwardedHost: req.headers["x-forwarded-host"],
            forwardedPort: req.headers["x-forwarded-port"],
          })
        );
      });

      await new Promise<void>((resolve) => {
        targetServer.listen(0, "127.0.0.1", () => {
          const addr = targetServer.address();
          targetPort = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    });

    it("proxies requests to the correct target based on Host header", async () => {
      // Start proxy on random port
      const proxyStatus = await svc.start(0);
      const proxyPort = proxyStatus.proxyPort;

      // Register route
      svc.addRoute("lane-test", targetPort, "test-lane");

      // Make request through proxy
      const response = await requestProxy(
        proxyPort,
        `test-lane.localhost:${proxyPort}`,
        "/hello",
      );

      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.path).toBe("/hello");
      expect(data.host).toBe(`test-lane.localhost:${proxyPort}`);
      expect(data.forwardedHost).toBe(`test-lane.localhost:${proxyPort}`);
      expect(data.forwardedPort).toBe(String(proxyPort));
    });

    it("returns 404 for unknown hostnames", async () => {
      const proxyStatus = await svc.start(0);
      const proxyPort = proxyStatus.proxyPort;

      const response = await requestProxy(proxyPort, `unknown.localhost:${proxyPort}`);

      expect(response.status).toBe(404);
      expect(response.body).toContain("No route for hostname");
    });

    it("returns 502 when target is unreachable", async () => {
      const proxyStatus = await svc.start(0);
      const proxyPort = proxyStatus.proxyPort;

      // Register route to a port that nothing is listening on
      svc.addRoute("dead-lane", 59999, "dead");

      const response = await requestProxy(proxyPort, `dead.localhost:${proxyPort}`);

      expect(response.status).toBe(502);
      expect(response.body).toContain("Proxy error");
    });

    it("lets interceptors short-circuit requests before hostname routing", async () => {
      const proxyStatus = await svc.start(0);
      const proxyPort = proxyStatus.proxyPort;

      svc.registerInterceptor((_req, res) => {
        res.writeHead(204, { "Content-Type": "text/plain" });
        res.end("intercepted");
        return true;
      });

      const response = await requestProxy(proxyPort, `ignored.localhost:${proxyPort}`);

      expect(response.status).toBe(204);
      expect(response.body).toBe("");
    });

    it("returns 500 when an interceptor throws", async () => {
      const proxyStatus = await svc.start(0);
      const proxyPort = proxyStatus.proxyPort;

      svc.registerInterceptor(() => {
        throw new Error("boom");
      });

      const response = await requestProxy(proxyPort, `ignored.localhost:${proxyPort}`);

      expect(response.status).toBe(500);
      expect(response.body).toContain("Proxy interceptor error");
    });
  });

  describe("request interceptors", () => {
    it("lets an interceptor short-circuit normal hostname routing", async () => {
      const proxyStatus = await svc.start(0);
      const proxyPort = proxyStatus.proxyPort;

      const interceptor = vi.fn((req: http.IncomingMessage, res: http.ServerResponse) => {
        if (req.url === "/oauth/callback") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("handled");
          return true;
        }
        return false;
      });

      svc.registerInterceptor(interceptor);

      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: proxyPort,
            path: "/oauth/callback",
            method: "GET",
            headers: { Host: `localhost:${proxyPort}` },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          }
        );
        req.on("error", reject);
        req.end();
      });

      expect(interceptor).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(response.body).toBe("handled");
    });

    it("stops calling an interceptor after unsubscribe", async () => {
      const proxyStatus = await svc.start(0);
      const proxyPort = proxyStatus.proxyPort;

      const interceptor = vi.fn((_req: http.IncomingMessage, _res: http.ServerResponse) => true);
      const unsubscribe = svc.registerInterceptor(interceptor);
      unsubscribe();

      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: proxyPort,
            path: "/oauth/callback",
            method: "GET",
            headers: { Host: `localhost:${proxyPort}` },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          }
        );
        req.on("error", reject);
        req.end();
      });

      expect(interceptor).not.toHaveBeenCalled();
      expect(response.status).toBe(404);
      expect(response.body).toContain("No route for hostname");
    });
  });

  describe("dispose", () => {
    it("clears all routes and stops server", async () => {
      svc.addRoute("lane-1", 3000, "a");
      await svc.start(0);
      await svc.dispose();

      expect(svc.listRoutes()).toHaveLength(0);
      expect(svc.getStatus().running).toBe(false);
    });
  });
});
