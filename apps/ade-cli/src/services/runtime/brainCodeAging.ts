import v8 from "node:v8";

/**
 * Compiled code that the brain ran while it started and does not run again.
 *
 * V8 drops the compiled form of a function (bytecode, Sparkplug code and
 * feedback) when the function has not run for `--bytecode-old-age` full
 * collections; the default is 6. A brain at rest makes few full collections,
 * so the code it ran only while it started stays compiled for the life of the
 * process. A reference snapshot of a brain at rest held 11 MB of Sparkplug
 * code, most of it in functions that run once (the command line parser, the
 * service factories).
 *
 * With 3, the first quiet full collection after the start drops that code. In
 * a Node bench of the same pattern (a start, then a quiet process with a
 * one-second timer), the collection at rest kept all of it with 4, 5 or 6, and
 * dropped it with 3. A function that runs again compiles again on its next
 * call: about 20 µs on average for the brain's own functions that had
 * Sparkplug code. Code that runs between collections keeps its age at zero,
 * so a busy path stays compiled.
 *
 * The flag is set a minute after the start, so the start itself compiles and
 * runs as before. `ADE_BRAIN_CODE_AGING=0` keeps V8's default, for a
 * comparison run.
 */

const BRAIN_BYTECODE_OLD_AGE = 3;
const SET_AFTER_START_MS = 60_000;
const CODE_AGING_ENV = "ADE_BRAIN_CODE_AGING";

let scheduled = false;

export function scheduleBrainCodeAging(): void {
  if (scheduled) return;
  scheduled = true;
  if (process.env[CODE_AGING_ENV]?.trim() === "0") return;
  const timer = setTimeout(() => {
    try {
      v8.setFlagsFromString(`--bytecode-old-age=${BRAIN_BYTECODE_OLD_AGE}`);
    } catch {
      // Memory only: the brain keeps V8's default.
    }
  }, SET_AFTER_START_MS);
  timer.unref?.();
}
