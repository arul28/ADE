import { parentPort } from "node:worker_threads";
import { encodeDisplayCopy, fitDecodableImage } from "./providerInlineImageCodec";
import type {
  ImageWorkerRequest,
  ImageWorkerResponse,
} from "./providerInlineImageWorkerPool";

/**
 * The image worker thread: runs `providerInlineImageCodec.ts` for one request
 * at a time and posts the result back, transferring the encoded bytes. Bundled
 * on its own as `providerInlineImageWorker.cjs` (both tsup configs; the
 * standalone runtime embeds it as an SEA asset), with pngjs and jpeg-js
 * inlined, so it needs nothing but Node built-ins.
 */

const noPause = (): Promise<void> => Promise.resolve();

/** A view the port can transfer: its own whole ArrayBuffer, never Node's shared Buffer pool. */
function ownBuffer(data: Uint8Array): Uint8Array {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer) {
    return data;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

async function handle(request: ImageWorkerRequest): Promise<{ response: ImageWorkerResponse; transfer: ArrayBuffer[] }> {
  try {
    const bytes = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength);
    if (request.op === "fit") {
      const result = await fitDecodableImage(bytes, request.isPng, noPause);
      if (result.kind !== "fitted") return { response: { id: request.id, ok: true, op: "fit", result }, transfer: [] };
      const data = ownBuffer(result.data);
      return { response: { id: request.id, ok: true, op: "fit", result: { ...result, data } }, transfer: [data.buffer as ArrayBuffer] };
    }
    const result = await encodeDisplayCopy(bytes, request.isPng, request.maxEdgePx, request.quality, noPause);
    if (!result) return { response: { id: request.id, ok: true, op: "display", result: null }, transfer: [] };
    const data = ownBuffer(result.data);
    return { response: { id: request.id, ok: true, op: "display", result: { ...result, data } }, transfer: [data.buffer as ArrayBuffer] };
  } catch (error) {
    return {
      response: {
        id: request.id,
        ok: false,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "Error", message: String(error) },
      },
      transfer: [],
    };
  }
}

const port = parentPort;
if (port) {
  port.on("message", (request: ImageWorkerRequest) => {
    void handle(request).then(({ response, transfer }) => {
      try {
        port.postMessage(response, transfer);
      } catch (error) {
        // A result the port cannot clone still answers, so the job never waits for its timeout.
        const message = error instanceof Error ? error.message : String(error);
        port.postMessage({ id: request.id, ok: false, error: { name: "Error", message } } satisfies ImageWorkerResponse);
      }
    });
  });
  // Tells the pool the bundle loaded; a worker that fails before this never ran a job.
  port.postMessage({ type: "ready" });
}
