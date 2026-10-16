import fs from "node:fs/promises";
import path from "node:path";

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

// Every Mach-O in a single-arch bundle must run on that arch. The x64 bundle is
// packaged on Apple Silicon, so a native file built for the host, or a platform
// package whose x64 copy never arrived, would otherwise ship unnoticed. A file
// without the target arch is allowed only when its path names the other arch
// (node-pty's prebuilds/darwin-arm64, say), and then the target-arch twin must
// sit beside it.
const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c };
const ARCH_PATH_TWINS = [
  ["darwin-arm64", "darwin-x64"],
  ["arm64-darwin", "x64-darwin"],
];

async function readMachOCpuTypes(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, 8, 0);
    if (bytesRead < 8) return null;
    const magic = header.readUInt32BE(0);
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) return [header.readUInt32LE(4)];
    if (magic === 0xfeedfacf || magic === 0xfeedface) return [header.readUInt32BE(4)];
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const count = header.readUInt32BE(4);
      if (count === 0 || count > 8) return null; // a Java class file shares this magic
      const stride = magic === 0xcafebabf ? 32 : 20;
      const table = Buffer.alloc(count * stride);
      await handle.read(table, 0, table.length, 8);
      return Array.from({ length: count }, (_, index) => table.readUInt32BE(index * stride));
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function assertMachOArchitectures(appPath, expectedArch, description) {
  const expectedCpu = MACHO_CPU[expectedArch];
  // A universal bundle carries both arches by design; only per-arch bundles
  // are checked.
  if (!expectedCpu) return;
  const twins = ARCH_PATH_TWINS.map(([arm64, x64]) => (expectedArch === "x64" ? [arm64, x64] : [x64, arm64]));
  const problems = [];
  let checked = 0;
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const cpus = await readMachOCpuTypes(entryPath);
      if (!cpus) continue;
      checked += 1;
      if (cpus.includes(expectedCpu)) continue;
      const relative = path.relative(appPath, entryPath);
      const twin = twins.find(([foreign]) => relative.includes(foreign));
      if (!twin) {
        problems.push(`${relative} has no ${expectedArch} code`);
      } else if (!(await pathExists(path.join(appPath, relative.split(twin[0]).join(twin[1]))))) {
        problems.push(`${relative} has no ${expectedArch} twin at ${relative.split(twin[0]).join(twin[1])}`);
      }
    }
  };
  await walk(appPath);
  if (problems.length > 0) {
    throw new Error(`[release:mac] Wrong-architecture Mach-O files in ${description}:\n  ${problems.join("\n  ")}`);
  }
  console.log(`[release:mac] All ${checked} Mach-O files in ${description} carry ${expectedArch} code or a ${expectedArch} twin`);
}
