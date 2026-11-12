/**
 * The notice layer: the bottom-right cards' own see-through window.
 *
 * A browser page is a native view drawn above ADE's whole renderer, so a card
 * the renderer draws in the corner can never paint over it. When a page covers
 * the corner, the renderer opens this one window (`window.open` under
 * `NOTICE_LAYER_FRAME_NAME`, the only window the app renderer may open), and
 * React portals the very same cards into it. The window is a child of the ADE
 * window, sits exactly over the corner, never takes focus, and shares the
 * renderer's process, state and handlers, so the cards behave as they always
 * do while the page around them stays live.
 */

/** The `window.open` target name the main process lets through, and nothing else. */
export const NOTICE_LAYER_FRAME_NAME = "ade-notice-layer";

/**
 * Where the layer goes, in the ADE window's renderer pixels (CSS pixels times
 * the renderer's zoom, as for browser view bounds). Null hides it.
 */
export type NoticeLayerRect = { x: number; y: number; width: number; height: number };
