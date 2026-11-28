import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudPhoneCallRequest, CloudPhoneStart, CloudPhoneState } from "../../../../../account-directory/src/cloud/contract";
import type { CloudProvider } from "./cloudProvider";
import { createCloudPhoneService } from "./cloudPhoneService";

const JOB = "33333333-3333-4333-8333-333333333333";

/**
 * A build that runs before any phone starts a phone for its install as the
 * build step passes. When the build then fails, that phone is stopped, but
 * only when this command's own start made it: a phone the start found already
 * running (another chat's, the person's) keeps running. The account server is
 * faked at its network boundary; packing runs the system's tar.
 */
describe("ADE Cloud iPhone: a phone started for a build that fails", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A Simulator `.app` folder on disk, as `ade apple install --app` takes. */
  function simulatorApp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-phone-test-"));
    dirs.push(dir);
    const app = path.join(dir, "Demo.app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>com.example.demo</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array></dict></plist>");
    return app;
  }

  /**
   * The account server: builds run before the phone; the build's step passes,
   * then packing its app fails. `alreadyRunning`: a phone was up before, so a
   * start answers it (`reused`) rather than making one.
   */
  function accountServer({ alreadyRunning }: { alreadyRunning: boolean }) {
    let live: CloudPhoneStart["phone"] | null = null;
    let statusReads = 0;
    const stops: number[] = [];
    const json = (body: unknown) => ({ status: 200, type: "application/json", body: Buffer.from(JSON.stringify(body)) });
    const phone: CloudPhoneStart["phone"] = { id: "phone-1", state: "ready", device: "iphone", readyAt: Date.now(), queueUntil: null, endReason: null, stopNotice: null, provider: "revyl" };
    const client = {
      account: "account-1",
      async phoneState(): Promise<CloudPhoneState> {
        return {
          access: "on",
          minutes: { included: 100, used: 0, left: 100 },
          phone: live,
          toolchains: [{ xcode: "27.2", sdk: "iOS 27.2", buildsBeforePhone: true, lacks: [] }],
        };
      },
      async phoneStart(): Promise<CloudPhoneStart> {
        live = phone;
        return { phone, reused: alreadyRunning, token: { token: "", expiresAt: Date.now() + 3_600_000 }, minutes: { included: 100, used: 0, left: 100 }, apiBase: "", provider: "revyl" };
      },
      async phoneStop() {
        stops.push(Date.now());
        live = null;
        return { stopped: true };
      },
      async phoneCall(input: CloudPhoneCallRequest) {
        if (input.action === "build.upload_url") return json({ upload_url: "https://uploads.example/put", upload_fields: { key: "k" } });
        if (input.action === "build.start") return json({ build_job_id: JOB });
        if (input.action === "build.logs") return json({ events: [{ message: "error: packing the app failed" }], has_more_before: false });
        if (input.action === "build.status") {
          statusReads += 1;
          const steps = [{ index: 1, type: "run", status: "success" }];
          return json(statusReads === 1 ? { status: "running", steps } : { status: "failed", error: "Upload application archive failed with exit code 1", steps });
        }
        return { status: 404, type: "application/json", body: Buffer.from("{}") };
      },
    } as unknown as CloudProvider;
    return { client, stops };
  }

  it.each([
    { name: "the phone its own start made is stopped, and the answer says so", alreadyRunning: false, stops: 1, said: /stopped at once/ },
    { name: "a phone that was already running keeps running", alreadyRunning: true, stops: 0, said: null },
  ])("$name", async ({ alreadyRunning, stops, said }) => {
    const server = accountServer({ alreadyRunning });
    const service = createCloudPhoneService({
      provider: async () => server.client,
      whyNoProvider: async () => null,
      fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    });

    const answer = await service.installApp({ appPath: simulatorApp() });

    expect(answer.failed).toBe(true);
    expect(server.stops).toHaveLength(stops);
    if (said) expect(answer.text).toMatch(said);
    else expect(answer.text).not.toMatch(/no phone minutes|stopped at once/);
  }, 30_000);
});
