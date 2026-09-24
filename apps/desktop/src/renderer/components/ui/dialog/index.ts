/**
 * ADE's dialog system. One modal shell (`Dialog`), one imperative confirm and
 * prompt (`confirmDialog` / `promptDialog`, rendered by `DialogHost`).
 *
 * Never hand-roll a `fixed inset-0` scrim + `role="dialog"` panel, and never
 * call `window.confirm` / `window.prompt` / `alert` in the renderer.
 */
export {
  Dialog,
  type DialogAction,
  type DialogLayer,
  type DialogProps,
  type DialogSize,
} from "./Dialog";
export {
  DialogHost,
  confirmDialog,
  promptDialog,
  type ConfirmDialogOptions,
  type PromptDialogOptions,
} from "./confirm";
