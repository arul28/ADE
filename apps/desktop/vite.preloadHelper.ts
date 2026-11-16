import type { Plugin } from "vite";

/*
 * A linear-time replacement for Vite's preload helper (`__vitePreload`), for
 * the Electron build only.
 *
 * Every lazy import goes through the helper with the list of chunks its
 * target needs, and the helper adds a `<link rel="modulepreload">` for each
 * chunk it has not seen. With a relative base (`./`, which the `file://` app
 * needs), Vite's helper first walks every `<link>` in the document,
 * backwards, for each new chunk and compares `link.href` (a URL serialised on
 * each read). Each chunk it adds is one more link to walk, so one call costs
 * deps × links: the boot import (about 430 chunks) and the early Work
 * preload (about 490 chunks, 150 of them new) read `href` about 170,000
 * times; the Work call alone was 22 ms of the launch profile.
 *
 * This helper does the same work with one walk per call: it reads the hrefs
 * of the links already in the page once into a set, then checks each chunk
 * against that set and against the chunks it has already handled. The links
 * it adds, their attributes, the order, the CSS waits and the
 * `vite:preloadError` event are Vite's.
 *
 * If a Vite upgrade stops loading the helper through this hook, the build
 * keeps Vite's own helper: slower, never broken. `generateBundle` warns then.
 */

const PRELOAD_HELPER_ID = "\0vite/preload-helper.js";

// Runs in the page. Kept to the syntax every target of this build supports.
const HELPER_SOURCE = `
// As Vite's with \`modulePreload.polyfill\` on (the default here).
const scriptRel = "modulepreload";
const seen = {};
export const __vitePreload = function preload(baseModule, deps, importerUrl) {
  let promise = Promise.resolve();
  if (deps && deps.length > 0) {
    // href -> a stylesheet link has it. Read once per call: links other code added since the last call count too.
    let present = null;
    const cspNonceMeta = document.querySelector("meta[property=csp-nonce]");
    const cspNonce = cspNonceMeta && (cspNonceMeta.nonce || cspNonceMeta.getAttribute("nonce"));
    function allSettled(promises) {
      return Promise.all(promises.map((p) => Promise.resolve(p).then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      )));
    }
    promise = allSettled(deps.map((dep) => {
      dep = importerUrl ? new URL(dep, importerUrl).href : dep;
      if (dep in seen) return;
      seen[dep] = true;
      const isCss = dep.endsWith(".css");
      if (present === null) {
        present = new Map();
        const links = document.getElementsByTagName("link");
        for (let i = 0; i < links.length; i++) {
          const link = links[i];
          present.set(link.href, present.get(link.href) === true || link.rel === "stylesheet");
        }
      }
      if (present.has(dep) && (!isCss || present.get(dep) === true)) return;
      const link = document.createElement("link");
      link.rel = isCss ? "stylesheet" : scriptRel;
      if (!isCss) link.as = "script";
      link.crossOrigin = "";
      link.href = dep;
      if (cspNonce) link.setAttribute("nonce", cspNonce);
      document.head.appendChild(link);
      if (isCss) return new Promise((res, rej) => {
        link.addEventListener("load", res);
        link.addEventListener("error", () => rej(new Error("Unable to preload CSS for " + dep)));
      });
    }));
  }
  function handlePreloadError(err) {
    const e = new Event("vite:preloadError", { cancelable: true });
    e.payload = err;
    window.dispatchEvent(e);
    if (!e.defaultPrevented) throw err;
  }
  return promise.then((res) => {
    for (const item of res || []) {
      if (item.status !== "rejected") continue;
      handlePreloadError(item.reason);
    }
    return baseModule().catch(handlePreloadError);
  });
};
`;

/** For a build with a relative base (`./`): Vite's own helper passes `importerUrl` only then. */
export function linearPreloadHelperPlugin(): Plugin {
  let used = false;
  return {
    name: "ade:linear-preload-helper",
    apply: "build",
    enforce: "pre",
    load(id) {
      if (id !== PRELOAD_HELPER_ID) return null;
      used = true;
      return { code: HELPER_SOURCE, moduleSideEffects: false };
    },
    generateBundle(_options, bundle) {
      // Vite's helper walks the links per chunk; this one builds a Map of them once per call.
      const helperChunk = Object.values(bundle).find((item) => item.type === "chunk" && item.moduleIds.includes(PRELOAD_HELPER_ID));
      if (helperChunk && helperChunk.type === "chunk" && !(used && helperChunk.code.includes("new Map"))) {
        this.warn("the linear preload helper is not in the output; Vite's own helper is in use");
      }
    },
  };
}
