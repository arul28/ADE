// Shared by the UI perf scripts: which renderer page to drive, and how to move it
// to a route. The dev renderer is http://localhost:<port>/ and routes by path
// (BrowserRouter). The packaged app loads file:///…/renderer/index.html and routes
// by hash (HashRouter reads location.hash, see App.tsx usesBrowserRouter), so
// its routes are #/work, #/lanes and so on.
//   CDP_PORT=<port>             the DevTools port (default 9222)
//   CDP_TARGET_URL=<substring>  the only page considered
//   --hash, CDP_HASH_ROUTES=1   navigate with location.hash
//   CDP_HASH_ROUTES=0           navigate with history.pushState, even on file:
//   (unset)                     hash routes when the page URL starts with file:

const DEV_PAGE = "//localhost:";
const PACKAGED_PAGE = /^file:.*\/index\.html([?#]|$)/;

// The dev app's DevTools endpoint: CDP_PORT (default 9222), for a dev app
// launched with another ADE_APP_CONTROL_CDP_PORT.
export const cdpUrl = (path) => `http://127.0.0.1:${process.env.CDP_PORT ?? 9222}${path}`;

// Arguments without flags, so `--hash` never lands in a script's positional arguments.
export const positionalArgs = () => process.argv.slice(2).filter((a) => a !== "--hash");

// The dev page first, else the packaged app's index.html. CDP_TARGET_URL replaces both.
export function findPage(list) {
  const pages = list.filter((x) => x.type === "page");
  if (process.env.CDP_TARGET_URL) return pages.find((x) => x.url.includes(process.env.CDP_TARGET_URL));
  return pages.find((x) => x.url.includes(DEV_PAGE)) ?? pages.find((x) => PACKAGED_PAGE.test(x.url));
}

export function useHashRoutes(page) {
  if (process.argv.includes("--hash") || process.env.CDP_HASH_ROUTES === "1") return true;
  if (process.env.CDP_HASH_ROUTES === "0") return false;
  return page.url.startsWith("file:");
}

// The dev branch is byte-for-byte the statement the scripts always ran. pushState fires
// no popstate, so it is dispatched by hand; a hash change fires popstate by itself.
export function navigateStatement(route, hash) {
  if (hash) return `location.hash = ${JSON.stringify("#" + route)};`;
  return `history.pushState({}, "", ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent("popstate"));`;
}
