import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createProjectConfigService } from "./projectConfigService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-linear-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const db = await openKvDb(path.join(adeDir, "ade.db"), createLogger());
  const service = createProjectConfigService({
    projectRoot: root,
    adeDir,
    projectId: "project-config-linear",
    db,
    logger: createLogger(),
  });
  return { root, adeDir, db, service };
}

describe("projectConfigService linearSync", () => {
  it("merges shared/local linear sync config with local precedence", async () => {
    const fixture = await createFixture();

    fixture.service.save({
      shared: {
        linearSync: {
          enabled: true,
          pollingIntervalSec: 300,
          projects: [{ slug: "acme-platform" }],
          routing: { byLabel: { bug: "backend-dev" } },
          autoDispatch: {
            default: "escalate",
            rules: [{ id: "rule-shared", action: "auto", match: { labels: ["bug"] } }],
          },
        },
      },
      local: {
        linearSync: {
          pollingIntervalSec: 120,
          routing: { byLabel: { feature: "frontend-dev" } },
          autoDispatch: {
            rules: [{ id: "rule-local", action: "queue-night-shift", match: { labels: ["night"] } }],
          },
        },
      },
    });

    const effective = fixture.service.getEffective();
    expect(effective.linearSync?.enabled).toBe(true);
    expect(effective.linearSync?.pollingIntervalSec).toBe(120);
    expect(effective.linearSync?.routing?.byLabel).toEqual({
      bug: "backend-dev",
      feature: "frontend-dev",
    });
    expect(effective.linearSync?.autoDispatch?.default).toBe("escalate");
    expect(effective.linearSync?.autoDispatch?.rules).toEqual([
      {
        id: "rule-local",
        action: "queue-night-shift",
        match: { labels: ["night"] },
      },
    ]);

    fixture.db.close();
  });

  it("clamps linear sync confidence threshold to valid range", async () => {
    const fixture = await createFixture();

    fixture.service.save({
      shared: {
        linearSync: {
          enabled: true,
          projects: [{ slug: "acme-platform" }],
          classification: { mode: "hybrid", confidenceThreshold: 1.4 },
        },
      },
      local: {},
    });

    const effective = fixture.service.getEffective();
    expect(effective.linearSync?.classification?.confidenceThreshold).toBe(1);

    fixture.db.close();
  });
});
