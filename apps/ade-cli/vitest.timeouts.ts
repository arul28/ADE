// Windows runners do real file, SQLite and pipe work several times slower than
// macOS/Linux. A timeout sized for a Mac flakes there on tests that pass, and
// a per-test override like `}, 30_000)` actually makes Windows STRICTER than
// the suite default, because the config's own default is already scaled.
//
// Assertion failures still fail; only the clock is loosened, and only on
// Windows. The factor defaults to 2 (the desktop app's ratio); this package
// raises it to 3 for the suite default, which was its own ratio before the
// helper existed. Keep the shape in step with apps/desktop/vitest.timeouts.ts.
export function windowsScaledTimeout(ms: number, factor = 2): number {
  return process.platform === "win32" ? ms * factor : ms;
}
