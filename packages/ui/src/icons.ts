/**
 * `@ade-dev/ui/icons` — the only module that pulls `@phosphor-icons/react`.
 *
 * It is a separate entry point on purpose. The icon set has no `sideEffects`
 * declaration of its own, so a bundler that sees it in the barrel keeps the
 * WHOLE set: importing one design token through the barrel dragged several
 * megabytes into the web client's entry graph. Anything that needs a glyph
 * imports it from here and pays for it deliberately.
 */
export { BranchIcon, LaneIcon } from "./primitives/vcsIcons";
