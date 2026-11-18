/**
 * The ADE Cloud iPhone's live view, as it crosses the three processes.
 *
 * NoMac (the service that runs the cloud iOS Simulator) gives a control-view
 * link whose page paints the phone into one canvas. Main renders that page in
 * an offscreen window and streams the cropped canvas here as JPEG; the 3D
 * device view draws it and sends taps back in device points.
 *
 * No pin anywhere: the view is a window on this desktop, tied to the renderer
 * that opened it, not to a lane on another machine.
 */

/** Which device the control page is showing, for input mapping and window size. */
export type CloudPhoneViewDeviceFamily = "iphone" | "ipad";

export type CloudPhoneViewOpenArgs = {
  /** The NoMac control-view link. It carries a viewer token, so never log it. */
  url: string;
  deviceFamily: CloudPhoneViewDeviceFamily;
  /** The phone's screen in points (`CLOUD_PHONE_POINT_SIZE`): what input coordinates are in. Left out: the family's default. */
  pointSize?: { width: number; height: number };
};

export type CloudPhoneViewOpenResult = {
  /** The offscreen view's id, for every later call about it. */
  viewId: string;
};

export type CloudPhoneViewCloseArgs = { viewId: string };

/** Pointer phases the 3D view produces; x and y are device points. */
export type CloudPhoneViewInputPhase = "begin" | "move" | "end";

export type CloudPhoneViewInputArgs = {
  viewId: string;
  phase: CloudPhoneViewInputPhase;
  x: number;
  y: number;
};

export type CloudPhoneViewScrollArgs = {
  viewId: string;
  /** Device points, the same space as input. */
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
};

export type CloudPhoneViewKeyArgs = {
  viewId: string;
  /** A printable single character, or one of the named keys the host maps. */
  key: string;
};

export type CloudPhoneViewHomeArgs = { viewId: string };

export type CloudPhoneViewSetHiddenArgs = {
  viewId: string;
  hidden: boolean;
};

/** One painted phone frame, cropped to the page's canvas. */
export type CloudPhoneViewFrame = {
  viewId: string;
  /** JPEG bytes of the cropped canvas. */
  jpeg: Uint8Array;
  /** The crop's size in PIXELS, which is also the canvas's own size. */
  width: number;
  height: number;
};

export type CloudPhoneViewState = "loading" | "live" | "ended" | "error";

export type CloudPhoneViewStateEvent = {
  viewId: string;
  state: CloudPhoneViewState;
  /** Present for `error`: a sentence for the strip, never the link. */
  message?: string;
};

/** `window.ade.cloudPhoneView`: desktop-only, so a browser has none of it. */
export type CloudPhoneViewPreloadApi = {
  open: (args: CloudPhoneViewOpenArgs) => Promise<CloudPhoneViewOpenResult>;
  close: (args: CloudPhoneViewCloseArgs) => Promise<void>;
  input: (args: CloudPhoneViewInputArgs) => Promise<void>;
  scroll: (args: CloudPhoneViewScrollArgs) => Promise<void>;
  key: (args: CloudPhoneViewKeyArgs) => Promise<void>;
  home: (args: CloudPhoneViewHomeArgs) => Promise<void>;
  setHidden: (args: CloudPhoneViewSetHiddenArgs) => Promise<void>;
  /** Each new frame this desktop paints, in any view. Returns its unsubscribe. */
  onFrame: (listener: (frame: CloudPhoneViewFrame) => void) => () => void;
  /** Each view's lifecycle; returns the unsubscribe. */
  onState: (listener: (event: CloudPhoneViewStateEvent) => void) => () => void;
};
