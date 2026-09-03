/**
 * Moved to `@ade-dev/ui`.
 *
 * The component is unchanged: it still emits the same Tailwind utilities, and
 * `cn` still lets a call site override them.
 */
export { Button } from "@ade-dev/ui";

/**
 * Tailwind's scanner reads SOURCE TEXT, and it does not look outside
 * `src/renderer`. The utilities below now live in `packages/ui`, so without
 * this anchor the generated stylesheet would be missing them and every Button
 * in the app would lose its size, weight and hover colours.
 *
 * Keep this string identical to the class names in
 * `packages/ui/src/primitives/Button.tsx`. It is scanned, never rendered.
 */
export const BUTTON_TAILWIND_ANCHOR =
  "inline-flex items-center justify-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all duration-100 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none h-7 px-3 h-8 px-4 text-[#0F0D14] hover:brightness-110 text-[#A1A1AA] hover:text-[#FAFAFA] hover:border-[#A78BFA50] text-[#71717A] hover:bg-[#1A1720] text-[#EF4444]";
