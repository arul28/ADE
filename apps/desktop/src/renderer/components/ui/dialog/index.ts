/**
 * ADE's dialog system. One modal shell (`Dialog`), one imperative confirm and
 * prompt (`confirmDialog` / `promptDialog`, rendered by `DialogHost`), and
 * `openDialog` for a feature's own `Dialog` opened from outside React.
 *
 * Never hand-roll a `fixed inset-0` scrim + `role="dialog"` panel, and never
 * call `window.confirm` / `window.prompt` / `alert` in the renderer.
 */
export {
  Dialog,
  DialogTitle,
  type DialogAction,
  type DialogLayer,
  type DialogPlacement,
  type DialogProps,
  type DialogSize,
} from "./Dialog";
export {
  DialogHost,
  confirmDialog,
  openDialog,
  promptDialog,
  type ConfirmDialogOptions,
  type PromptDialogOptions,
} from "./confirm";
