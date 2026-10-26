// The runtime bundles never run inside Electron's main process: the brain and
// the CLI run as plain Node (ELECTRON_RUN_AS_NODE), where `require("electron")`
// would load the npm package's launcher shim. Since Electron 44 that shim
// downloads the Electron binary on first require (spawning an install script
// and printing to stdout), so the bundles take this module instead. Throwing
// keeps the old outcome: callers that try `require("electron")` (safeStorage,
// nativeImage) fall back as they did when the shim threw.
throw new Error("Electron APIs are not available in the ADE runtime.");
