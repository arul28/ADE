/**
 * The only host a direct-file tool pin may download from: Meta's lookaside host,
 * which serves the muse builds. The pin scripts import this; `src/services/tools/manifest.ts`
 * repeats the same literal (the TypeScript side cannot import a script), and the
 * downloader refuses any redirect off the pinned host.
 */
export const FILE_PIN_HOST = "lookaside.facebook.com";
