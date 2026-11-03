/*
 * TEMPORARY dev harness (deleted before the PR): runs the Android SDK, AVD
 * and lifecycle backend for real on a machine with an SDK.
 *
 *   npx -y tsx apps/desktop/scripts/android-dev/lifecycle-smoke.ts [--no-boot]
 *
 * Creates `ade_smoke*` AVDs, boots at most one emulator, stops it, deletes
 * every AVD it made. Never touches an emulator it did not start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  androidAvdHome,
  androidSdkPaths,
  androidUserHome,
  listAndroidSystemImages,
  readAndroidSdkStatus,
} from "../../src/main/services/android/androidSdk";
import {
  androidSdklibJarCandidates,
  listAndroidDeviceDefinitions,
  readZipTextEntries,
} from "../../src/main/services/android/androidHardwareProfiles";
import { createAndroidAvd, deleteAdeAndroidAvd, listAndroidAvds, readAdeAvdLaneId } from "../../src/main/services/android/androidAvds";
import {
  AdeStartedEmulators,
  allocateAndroidEmulatorPorts,
  androidDiscoveryDirs,
  isProcessAlive,
  launchAndroidEmulator,
  readRunningAndroidEmulators,
  stopAndroidEmulator,
  waitForAndroidBoot,
} from "../../src/main/services/android/androidEmulatorProcess";
import { AndroidEmulatorFailure } from "../../src/main/services/android/androidEmulatorErrors";

const noBoot = process.argv.includes("--no-boot");
const out = (label: string, value: unknown) => console.log(`\n## ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
const timed = async <T>(fn: () => T | Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - t0)];
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const created: string[] = [];
const work = path.join(os.tmpdir(), "ade-android-lifecycle-smoke");
fs.mkdirSync(work, { recursive: true });
const registry = new AdeStartedEmulators(path.join(work, "started.json"));
let liveStop: (() => Promise<unknown>) | null = null;

async function main() {
  const [status, statusMs] = await timed(() => readAndroidSdkStatus({ forceAccelCheck: true }));
  out(`sdk status (cold, ${statusMs} ms)`, status);
  const [, warmMs] = await timed(() => readAndroidSdkStatus());
  out("sdk status warm ms (accel cached)", warmMs);
  out("sdk status with a bogus setting path falls through", (await readAndroidSdkStatus({ settingPath: "C:\\nope\\sdk" })).source);
  if (!status.root) throw new Error("no SDK");
  const paths = androidSdkPaths(status.root);
  const avdHome = androidAvdHome();
  out("paths", { ...paths, avdHome, userHome: androidUserHome(), discoveryDirs: androidDiscoveryDirs() });

  const images = listAndroidSystemImages(status.root);
  out("system images", images);

  const [avds, avdMs] = await timed(() => listAndroidAvds(avdHome, { measureSize: true }));
  out(`avds (${avds.length}, ${avdMs} ms with sizes)`, avds.map((avd) => ({
    name: avd.name, profile: avd.profileId, api: avd.apiLevel, tag: avd.tag, abi: avd.abi,
    lcd: `${avd.lcdWidth}x${avd.lcdHeight}@${avd.density}`, gb: avd.sizeBytes ? +(avd.sizeBytes / 1e9).toFixed(2) : null, ade: avd.adeCreated,
  })));

  const [definitions, profileColdMs] = await timed(() => listAndroidDeviceDefinitions({ sdkRoot: status.root, systemImageDirs: images.map((image) => image.path) }));
  const [, profileWarmMs] = await timed(() => listAndroidDeviceDefinitions({ sdkRoot: status.root, systemImageDirs: images.map((image) => image.path) }));
  const byForm: Record<string, number> = {};
  for (const definition of definitions) byForm[definition.profile.formFactor ?? "?"] = (byForm[definition.profile.formFactor ?? "?"] ?? 0) + 1;
  out(`profiles (${definitions.length}; cold ${profileColdMs} ms, warm ${profileWarmMs} ms)`, byForm);
  out("profile ids", definitions.map((definition) => definition.profile.id).join(" "));
  out("pixel_9_pro_fold", definitions.find((definition) => definition.profile.id === "pixel_9_pro_fold"));
  out("medium_phone profile", definitions.find((definition) => definition.profile.id === "medium_phone")?.profile);
  for (const jar of androidSdklibJarCandidates(status.root)) {
    if (!fs.existsSync(jar)) continue;
    const [entries, ms] = await timed(() => readZipTextEntries(jar, (name) => name.startsWith("com/android/sdklib/devices/") && name.endsWith(".xml")));
    out(`jar ${jar}`, `${entries.size} device xml files in ${ms} ms`);
  }

  const running = await readRunningAndroidEmulators({ registry, adbPath: paths.adb });
  out("running emulators before", running);
  const ports = await allocateAndroidEmulatorPorts(running);
  out("allocated ports (should skip running ones)", { consolePort: ports.consolePort, adbPort: ports.adbPort, grpcPort: ports.grpcPort });
  ports.release();

  out("refuses to delete a user's AVD", (() => {
    try {
      deleteAdeAndroidAvd(avdHome, "vphone2", running);
      return "DELETED (BAD)";
    } catch (error) {
      return (error as Error).message;
    }
  })());

  const image = images.find((candidate) => candidate.abi === status.hostAbi);
  const phone = definitions.find((definition) => definition.profile.id === "medium_phone");
  if (!image || !phone) throw new Error("no host image or medium_phone profile");
  const [avd, createMs] = await timed(() => createAndroidAvd({
    sdkRoot: status.root!, avdHome, userHome: androidUserHome(), laneId: "smoke-lane-0001", definition: phone, image, displayName: "ADE smoke",
  }));
  created.push(avd.name);
  out(`created ${avd.name} in ${createMs} ms`, { avd, laneId: readAdeAvdLaneId(avd) });
  out("config.ini", fs.readFileSync(path.join(avd.path, "config.ini"), "utf8"));
  out(".ini", fs.readFileSync(path.join(avdHome, `${avd.name}.ini`), "utf8"));
  const fold = definitions.find((definition) => definition.profile.id === "pixel_9_pro_fold");
  if (fold) {
    const foldAvd = createAndroidAvd({ sdkRoot: status.root, avdHome, userHome: androidUserHome(), laneId: "smoke-lane-0001", definition: fold, image });
    created.push(foldAvd.name);
    out(`created foldable ${foldAvd.name}`, fs.readFileSync(path.join(foldAvd.path, "config.ini"), "utf8").split("\n").filter((line) => /hinge|posture|displayRegion|lcd/u.test(line)).join("\n"));
  }

  if (noBoot) return;

  // Crash case, cheap: an AVD whose system image path is wrong exits at once.
  const broken = createAndroidAvd({ sdkRoot: status.root, avdHome, userHome: androidUserHome(), laneId: "smoke-lane-0001", definition: phone, image });
  created.push(broken.name);
  const brokenConfig = path.join(broken.path, "config.ini");
  fs.writeFileSync(brokenConfig, fs.readFileSync(brokenConfig, "utf8").replace(/^image\.sysdir\.1=.*$/mu, "image.sysdir.1=system-images/android-999/nope/x86_64/"));
  const crashLaunch = await launchAndroidEmulator({
    emulatorPath: paths.emulator, sdkRoot: status.root, avdHome, avdName: broken.name,
    logPath: path.join(work, `${broken.name}.log`), snapshot: "cold", registry,
  });
  const [crash, crashMs] = await timed(async () => {
    try {
      await waitForAndroidBoot(crashLaunch, { adbPath: paths.adb, timeoutMs: 60_000, registry });
      return "BOOTED (unexpected)";
    } catch (error) {
      return error instanceof AndroidEmulatorFailure ? error.toAndroidEmulatorError() : String(error);
    }
  });
  out(`crash case (${crashMs} ms)`, crash);
  out("crash launcher alive after?", isProcessAlive(crashLaunch.launcherPid));

  // Boot one emulator: only when nobody else's (besides the owner's) is up and RAM allows.
  for (let attempt = 0; ; attempt += 1) {
    const others = (await readRunningAndroidEmulators({ registry })).filter((emulator) => emulator.avdName !== "versic_tablet");
    if (others.length === 0) break;
    if (attempt >= 18) throw new Error(`another emulator is running: ${others.map((emulator) => emulator.avdName).join(", ")}`);
    out("waiting for another agent's emulator to stop", others.map((emulator) => emulator.avdName));
    await sleep(10_000);
  }
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  out("free MB before boot", freeMb);
  if (freeMb < 4000) {
    out("SKIP BOOT", "less than 4000 MB free");
    return;
  }

  const logPath = path.join(work, `${avd.name}.log`);
  for (const label of ["first boot (builds the disks)", "second cold boot"]) {
    const free = Math.round(os.freemem() / 1024 / 1024);
    if (free < 4000) {
      out("SKIP BOOT", `${free} MB free`);
      return;
    }
    const launch = await launchAndroidEmulator({
      emulatorPath: paths.emulator, sdkRoot: status.root, avdHome, avdName: avd.name, logPath, snapshot: "cold", registry,
    });
    out(`${label}: launched`, { serial: launch.serial, consolePort: launch.consolePort, grpcPort: launch.grpcPort, launcherPid: launch.launcherPid });
    liveStop = async () => {
      const found = (await readRunningAndroidEmulators({ registry })).find((emulator) => emulator.avdName === avd.name);
      if (found) {
        await stopAndroidEmulator({ adbPath: paths.adb, serial: found.serial, consolePort: found.consolePort, avdName: avd.name, pid: found.pid, launcherPid: launch.launcherPid, registry });
      } else if (isProcessAlive(launch.launcherPid)) {
        process.kill(launch.launcherPid);
      }
    };
    const boot = await waitForAndroidBoot(launch, { adbPath: paths.adb, timeoutMs: 180_000, registry });
    out(`${label}: booted`, boot);

    const runningNow = await readRunningAndroidEmulators({ registry, adbPath: paths.adb });
    out("running emulators while booted", runningNow);
    const me = runningNow.find((emulator) => emulator.avdName === avd.name);
    if (!me) throw new Error("own emulator not in discovery");
    out("restart-safe ownership (fresh registry from the same file)", new AdeStartedEmulators(path.join(work, "started.json")).owns(me));
    out("avd row shows running", listAndroidAvds(avdHome, { running: runningNow }).find((entry) => entry.name === avd.name)?.running?.serial);
    out("start the same AVD again", await launchAndroidEmulator({
      emulatorPath: paths.emulator, sdkRoot: status.root, avdHome, avdName: avd.name, logPath, snapshot: "cold",
    }).then(() => "LAUNCHED (bad)", (error) => (error as Error).message));
    out("delete while running", (() => {
      try {
        deleteAdeAndroidAvd(avdHome, avd.name, runningNow);
        return "DELETED (bad)";
      } catch (error) {
        return (error as Error).message;
      }
    })());
    out("delete while running, with a stale running list (rename guard)", (() => {
      try {
        deleteAdeAndroidAvd(avdHome, avd.name, []);
        return "DELETED (bad)";
      } catch (error) {
        return `${(error as Error).message} | ini still there: ${fs.existsSync(path.join(avdHome, `${avd.name}.ini`))}`;
      }
    })());

    const stop = await stopAndroidEmulator({
      adbPath: paths.adb, serial: me.serial, consolePort: me.consolePort, avdName: me.avdName, pid: me.pid, launcherPid: launch.launcherPid, registry,
    });
    liveStop = null;
    out(`${label}: stopped`, { ...stop, qemuAlive: isProcessAlive(me.pid), launcherAlive: isProcessAlive(launch.launcherPid), exit: await Promise.race([launch.exit, sleep(3000).then(() => "no exit event")]) });
  }
  out("owner's emulator untouched", (await readRunningAndroidEmulators({ registry })).map((emulator) => `${emulator.avdName} ${emulator.serial} ade=${emulator.startedByAde}`));
  const log = fs.readFileSync(logPath, "utf8").split(/\r?\n/u);
  out("log warnings/errors", log.filter((line) => /WARNING|ERROR|unknown|ade\./iu.test(line)).slice(0, 25).join("\n"));
  out("log tail", log.slice(-6).join("\n"));
}

main()
  .catch((error) => {
    console.log(`\n## FAILED\n${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (liveStop) {
      await liveStop().catch((error) => console.log(`cleanup stop failed: ${String(error)}`));
    }
    const avdHome = androidAvdHome();
    for (const name of created) {
      try {
        deleteAdeAndroidAvd(avdHome, name, await readRunningAndroidEmulators());
        console.log(`deleted ${name}: ini ${fs.existsSync(path.join(avdHome, `${name}.ini`))} folder ${fs.existsSync(path.join(avdHome, `${name}.avd`))}`);
      } catch (error) {
        console.log(`delete ${name} failed: ${(error as Error).message}`);
      }
    }
  });
