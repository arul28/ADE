/**
 * Builds a logo's signed distance field off the page's thread, run as a worker
 * by `logoTexture.ts`. One request, one answer: the page sends the logo
 * texture's RGBA pixels and gets the field back, both moved, not copied.
 */
import { sdfFromRgba } from "./logoSdf";

export type LogoSdfRequest = { rgba: Uint8ClampedArray; size: number };
export type LogoSdfResponse = { sdf: Float32Array };

/** The worker's own global scope, as far as this program uses it. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LogoSdfRequest>) => void) | null;
  postMessage(message: LogoSdfResponse, transfer: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { rgba, size } = event.data;
  const sdf = sdfFromRgba(rgba, size);
  scope.postMessage({ sdf }, [sdf.buffer]);
};
