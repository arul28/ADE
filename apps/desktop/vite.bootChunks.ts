import type { Plugin } from "vite";

/*
 * Puts the renderer's startup code in two chunks instead of about 410.
 *
 * Automatic chunking gives each set of modules that the same lazy entries
 * share a chunk of its own. The startup path (`rendererBoot.tsx` and what it
 * imports) shares small modules with hundreds of lazy chunks, so the first
 * load requested about 410 files for 4.3 MB, most under 4 KB, each one a
 * separate module request (and one more pass through main's response hook).
 *
 * The `app-boot` group takes the app's own modules that `rendererBoot.tsx`
 * imports. Rolldown adds the packages they use (only the imports that stay
 * after tree-shaking), so the group holds the code that startup loaded
 * before, and no more. The import graph is not used for packages: through
 * their index files it reaches code that tree-shaking drops (katex, dayjs,
 * stylis), and a group that named those modules would load them at startup.
 *
 * Every lazy chunk that needs a startup module now imports the boot chunk,
 * which is always loaded by then, so no lazy page loads code that it did not
 * load before, and no module is in two chunks.
 *
 * `browserMock.ts` runs before `rendererBoot.tsx` when there is no Electron
 * preload. It must not load the boot chunk, which runs the app. The modules
 * it shares with startup go in `app-boot-shared`, which both load, and the
 * modules it shares with lazy code stay in automatic chunks. `generateBundle`
 * checks that neither the entry nor the mock reaches the boot chunk.
 *
 * The Work page (`TerminalsPage`, about 145 more chunks) is not grouped: its
 * modules are shared with other pages in many combinations, and one group
 * made every page (the project welcome page too) load 3.5 MB of Work code.
 */

const BOOT_ROOT = "/src/renderer/rendererBoot.tsx";
const MOCK_ROOT = "/src/renderer/browserMock.ts";

type ModuleGraph = { getModuleInfo(id: string): { importedIds: readonly string[] } | null };
type GroupName = (id: string) => string | null;

const normalize = (id: string): string => id.replace(/\\/g, "/");
/** The app's own modules: the import graph is accurate for these. */
const isAppModule = (id: string): boolean => !id.startsWith("\0") && !normalize(id).includes("/node_modules/");

function staticClosure(graph: ModuleGraph, root: string | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    const info = graph.getModuleInfo(id);
    if (!info) continue;
    seen.add(id);
    for (const imported of info.importedIds) stack.push(imported);
  }
  return seen;
}

export function bootChunks(): { groups: Array<{ name: GroupName; priority: number }>; plugin: Plugin } {
  let boot = new Set<string>();
  let shared = new Set<string>();
  let bootRoot: string | undefined;

  const plugin: Plugin = {
    name: "ade-boot-chunks",
    apply: "build",
    buildEnd(error) {
      boot = new Set();
      shared = new Set();
      bootRoot = undefined;
      if (error) return;
      const ids = [...this.getModuleIds()];
      bootRoot = ids.find((id) => normalize(id).endsWith(BOOT_ROOT));
      if (!bootRoot) {
        this.warn(`ade-boot-chunks: ${BOOT_ROOT} is not in the build; startup keeps automatic chunks.`);
        return;
      }
      const mock = staticClosure(this, ids.find((id) => normalize(id).endsWith(MOCK_ROOT)));
      for (const id of staticClosure(this, bootRoot)) {
        if (!isAppModule(id)) continue;
        (mock.has(id) ? shared : boot).add(id);
      }
    },
    generateBundle(_options, bundle) {
      const chunks = new Map<string, { imports: string[]; moduleIds: string[]; isEntry: boolean; facadeModuleId: string | null }>();
      for (const output of Object.values(bundle)) if (output.type === "chunk") chunks.set(output.fileName, output);
      const reachesBoot = (start: string): boolean => {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length > 0) {
          const fileName = stack.pop()!;
          if (seen.has(fileName)) continue;
          seen.add(fileName);
          const chunk = chunks.get(fileName);
          if (!chunk) continue;
          // The group chunk holds rendererBoot's own code; its facade only imports it.
          if (bootRoot && chunk.moduleIds.includes(bootRoot)) return true;
          stack.push(...chunk.imports);
        }
        return false;
      };
      for (const [fileName, chunk] of chunks) {
        const facade = chunk.facadeModuleId ? normalize(chunk.facadeModuleId) : "";
        // The entry decides whether the mock loads; the boot chunk would run the app first.
        if (chunk.isEntry && reachesBoot(fileName)) {
          this.error(`ade-boot-chunks: the entry ${fileName} statically imports the boot chunk, so the app would start before main.tsx checks for the preload.`);
        }
        if (facade.endsWith(MOCK_ROOT) && reachesBoot(fileName)) {
          this.warn(`ade-boot-chunks: ${fileName} imports the boot chunk, so the browser preview starts the app before its mock is in place.`);
        }
      }
    },
  };

  return {
    groups: [
      { name: (id) => (shared.has(id) ? "app-boot-shared" : null), priority: 2 },
      { name: (id) => (boot.has(id) ? "app-boot" : null), priority: 1 },
    ],
    plugin,
  };
}
