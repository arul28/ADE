/**
 * Moved to `@ade-dev/ui`.
 *
 * One behavioural note: the enter transition now runs through the Web
 * Animations API instead of `motion/react`, so a plugin page does not have to
 * bundle an animation runtime for a single 300 ms fade-and-rise. The keyframes,
 * duration and easing are the same.
 */
export { EmptyState } from "@ade-dev/ui";

/** See `BUTTON_TAILWIND_ANCHOR` in `./Button` for why this string exists. */
export const EMPTY_STATE_TAILWIND_ANCHOR =
  "flex flex-col items-center justify-center p-10 text-center mb-4 inline-flex items-center justify-center text-[#52525B] text-[14px] font-bold tracking-[-0.3px] text-[#FAFAFA] mt-2 font-mono text-[11px] text-[#71717A] max-w-[45ch] mx-auto leading-relaxed";
