/**
 * Design tokens for the Automations UI.
 *
 * Automations is a long-form builder, so it uses slightly brighter surfaces
 * than the CTO dashboard tokens. That keeps prompts and form labels legible
 * when users are scanning multi-step rules.
 */
export { ACCENT } from "../cto/shared/designTokens";

export const inputCls =
  "h-8 w-full rounded-md border border-white/[0.14] bg-[#152235] px-3 text-xs font-sans text-[#F8FAFC] shadow-[inset_0_1px_1px_rgba(0,0,0,0.18)] placeholder:text-[#94A3B8] hover:border-[#7DD3FC]/35 focus:border-[#7DD3FC]/55 focus:shadow-[0_0_0_2px_rgba(125,211,252,0.14)] focus:outline-none transition-all duration-150";

export const selectCls = `${inputCls} appearance-none`;

export const labelCls =
  "mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#AFC0D4]";

export const textareaCls =
  "w-full resize-y rounded-md border border-white/[0.14] bg-[#152235] p-3 text-xs font-sans text-[#F8FAFC] shadow-[inset_0_1px_1px_rgba(0,0,0,0.18)] placeholder:text-[#94A3B8] hover:border-[#7DD3FC]/35 focus:border-[#7DD3FC]/55 focus:shadow-[0_0_0_2px_rgba(125,211,252,0.14)] focus:outline-none transition-all duration-150";

export const cardCls =
  "rounded-xl border border-white/[0.12] bg-[#162235] p-5 shadow-[0_18px_45px_rgba(0,0,0,0.18)]";

export const surfaceCardCls =
  "rounded-xl border border-white/[0.12] bg-[#162235] p-4 shadow-[0_14px_34px_rgba(0,0,0,0.16)]";

export const recessedPanelCls =
  "rounded-lg border border-white/[0.12] bg-[#111C2B] shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]";
