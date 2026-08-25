import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyStorageLocation,
  collectStorageEnvironment,
  detectLaunchdManaged,
} from "./storageEnvironmentProbe";

/**
 * The probe exists because a report about "Unknown system error -11" never said
 * the project was in iCloud Drive and never said its files had been evicted.
 * These cover the three things it therefore has to get right: the enum, the
 * dataless count, and the bounds that keep a diagnostic collector from becoming
 * the outage it is collecting.
 */

const tempDirs: string[] = [];

function tempTree(spec: Record<string, number>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-probe-"));
  tempDirs.push(root);
  for (const [relative, size] of Object.entries(spec)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x".repeat(size));
  }
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stat seam that makes named files look like unmaterialized placeholders. */
function datalessStat(datalessNames: readonly string[]) {
  return (target: string): Pick<fs.Stats, "size" | "blocks"> => {
    const real = fs.statSync(target);
    if (datalessNames.includes(path.basename(target))) return { size: real.size, blocks: 0 };
    return { size: real.size, blocks: real.blocks || 8 };
  };
}

describe("classifyStorageLocation", () => {
  it("names each cloud provider a project can sit inside", () => {
    expect(classifyStorageLocation("/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/app", "darwin"))
      .toBe("icloud");
    expect(classifyStorageLocation("/Users/ada/Dropbox/app", "darwin")).toBe("dropbox");
    expect(classifyStorageLocation("/Users/ada/Library/CloudStorage/Box-Work/app", "darwin"))
      .toBe("cloud-storage");
    expect(classifyStorageLocation("C:\\Users\\ada\\OneDrive - Contoso\\app", "win32"))
      .toBe("onedrive");
  });

  it("separates an external or network volume from the boot disk", () => {
    expect(classifyStorageLocation("/Volumes/Backup/app", "darwin")).toBe("external-volume");
    expect(classifyStorageLocation("/mnt/scratch/app", "linux")).toBe("external-volume");
    expect(classifyStorageLocation("\\\\fileserver\\team\\app", "win32")).toBe("network-volume");
    expect(classifyStorageLocation("D:\\work\\app", "win32")).toBe("external-volume");
  });

  it("reports an ordinary path on the boot disk as local", () => {
    expect(classifyStorageLocation("/Users/ada/Projects/app", "darwin")).toBe("local");
    expect(classifyStorageLocation("C:\\Users\\ada\\Projects\\app", "win32")).toBe("local");
  });

  it("takes the Windows boot drive from SystemDrive rather than assuming C:", () => {
    // A machine that boots from D: is ordinary in managed fleets, and calling
    // its own boot disk removable would put a false warning in every report.
    const env = { SystemDrive: "D:" } as NodeJS.ProcessEnv;
    expect(classifyStorageLocation("D:\\Users\\ada\\Projects\\app", "win32", env)).toBe("local");
    expect(classifyStorageLocation("C:\\work\\app", "win32", env)).toBe("external-volume");
  });

  it("prefers the provider over the volume for a cloud client that mounts one", () => {
    expect(classifyStorageLocation("/Volumes/GoogleDrive/My Drive/app", "darwin"))
      .toBe("google-drive");
  });
});

describe("detectLaunchdManaged", () => {
  it("reads launchd's own job label", () => {
    expect(detectLaunchdManaged({ XPC_SERVICE_NAME: "com.ade.runtime" }, 501)).toBe(true);
  });

  it("does not mistake a login shell for a launchd job", () => {
    expect(detectLaunchdManaged({ XPC_SERVICE_NAME: "0" }, 501)).toBe(false);
    expect(detectLaunchdManaged({}, 501)).toBe(false);
  });

  it("treats a process reparented to pid 1 as launchd-managed", () => {
    expect(detectLaunchdManaged({}, 1)).toBe(true);
  });
});

describe("collectStorageEnvironment", () => {
  it("counts the dataless files in a sample without naming any of them", () => {
    const root = tempTree({ "a.db": 10, "b.txt": 10, "nested/c.db": 10 });
    const result = collectStorageEnvironment([{ label: "Project", path: root }], {
      platform: "darwin",
      env: {},
      statSync: datalessStat(["a.db", "c.db"]),
    });

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]).toMatchObject({
      label: "Project",
      location: "local",
      sampledFiles: 3,
      datalessFiles: 2,
      sampleTruncated: false,
    });
    // The whole privacy contract of the section, asserted rather than assumed.
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("a.db");
  });

  it("stops at the file cap and says the sample is a prefix", () => {
    const root = tempTree(Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`file-${index}.txt`, 4]),
    ));
    const result = collectStorageEnvironment([{ label: "ADE home", path: root }], {
      platform: "darwin",
      env: {},
      maxFiles: 5,
    });
    expect(result.roots[0]?.sampledFiles).toBe(5);
    expect(result.roots[0]?.sampleTruncated).toBe(true);
  });

  it("stops at the time budget rather than walking a large tree", () => {
    const root = tempTree({ "one/a.txt": 4, "two/b.txt": 4, "three/c.txt": 4 });
    let clock = 0;
    const result = collectStorageEnvironment([{ label: "Project", path: root }], {
      platform: "darwin",
      env: {},
      // Every loop turn costs 10ms of the 15ms budget, so the walk gets the
      // root and one subdirectory and then has to stop.
      now: () => (clock += 10),
      timeBudgetMs: 15,
    });
    expect(result.roots[0]?.sampleTruncated).toBe(true);
  });

  it("reports an unreadable root as unread rather than as zero dataless files", () => {
    const result = collectStorageEnvironment(
      [{ label: "Project", path: path.join(os.tmpdir(), "ade-storage-probe-missing") }],
      { platform: "darwin", env: {} },
    );
    expect(result.roots[0]?.error).toBe("(could not be read)");
    expect(result.roots[0]?.sampledFiles).toBe(0);
  });

  it("collects with pure fs calls: no command runs and no brain is contacted", () => {
    const root = tempTree({ "a.txt": 4 });
    const readPaths: string[] = [];
    const result = collectStorageEnvironment([{ label: "ADE home", path: root }], {
      platform: "darwin",
      env: { XPC_SERVICE_NAME: "com.ade.runtime" },
      processType: "cli",
      parentPid: 1,
      statSync: (target) => {
        readPaths.push(target);
        return fs.statSync(target);
      },
    });
    expect(readPaths.length).toBeGreaterThan(0);
    expect(result.process).toEqual({
      platform: "darwin",
      processType: "cli",
      launchdManaged: true,
      materializeDatalessFiles: null,
    });
  });

  /**
   * The distinction the whole investigation turned on: a provider that will not
   * hand the bytes to ANYBODY, versus a background service that is not allowed
   * to ask for them. `launchd.plist(5)` exposes the same switch as
   * `setiopolicy_np`, so the second case is an ordinary file read away.
   */
  it("reads the materialization policy off the installed launch agent", () => {
    const root = tempTree({ "a.txt": 4 });
    const plist = (granted: boolean) => [
      "<dict>",
      "  <key>Label</key>",
      "  <string>com.ade.runtime</string>",
      "  <key>MaterializeDatalessFiles</key>",
      `  <${granted ? "true" : "false"}/>`,
      "</dict>",
    ].join("\n");

    const granted = collectStorageEnvironment([{ label: "ADE home", path: root }], {
      platform: "darwin",
      env: {},
      launchAgentPath: "/agents/com.ade.runtime.plist",
      readFileSync: () => plist(true),
    });
    expect(granted.process.materializeDatalessFiles).toBe(true);

    const denied = collectStorageEnvironment([{ label: "ADE home", path: root }], {
      platform: "darwin",
      env: {},
      launchAgentPath: "/agents/com.ade.runtime.plist",
      readFileSync: () => plist(false),
    });
    expect(denied.process.materializeDatalessFiles).toBe(false);
  });

  it("reports an unknown policy rather than guessing one", () => {
    const root = tempTree({ "a.txt": 4 });
    // A launch agent installed before ADE set the key at all: it says nothing
    // about materialization, which is not the same fact as saying no.
    const older = collectStorageEnvironment([{ label: "ADE home", path: root }], {
      platform: "darwin",
      env: {},
      launchAgentPath: "/agents/com.ade.runtime.plist",
      readFileSync: () => "<dict><key>Label</key><string>com.ade.runtime</string></dict>",
    });
    expect(older.process.materializeDatalessFiles).toBeNull();

    const missing = collectStorageEnvironment([{ label: "ADE home", path: root }], {
      platform: "darwin",
      env: {},
      launchAgentPath: "/agents/com.ade.runtime.plist",
      readFileSync: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(missing.process.materializeDatalessFiles).toBeNull();
  });

  it("states the materialization-policy limit, and the extra Windows one", () => {
    const root = tempTree({ "a.txt": 4 });
    const darwin = collectStorageEnvironment([{ label: "ADE home", path: root }], {
      platform: "darwin",
      env: {},
    });
    expect(darwin.limitations).toHaveLength(1);
    expect(darwin.limitations[0]).toContain("installed launch agent");

    const windows = collectStorageEnvironment([{ label: "ADE home", path: root }], {
      platform: "win32",
      env: {},
    });
    expect(windows.limitations).toHaveLength(2);
    expect(windows.limitations[1]).toContain("FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS");
    expect(windows.process.launchdManaged).toBeNull();
  });
});
