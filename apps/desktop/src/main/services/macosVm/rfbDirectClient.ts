import { deflateSync } from "node:zlib";
import { VncClient } from "@wize-logic/nodejs-rfb";

export type DirectVncConnection = {
  host: string;
  port: number;
  password?: string | null;
};

export type DirectVncScreenshot = {
  width: number;
  height: number;
  pngData: Buffer;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MOUSE_LEFT_BUTTON = 1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const PNG_CRC_TABLE = crcTable();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = PNG_CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (stride + 1);
    scanlines[targetOffset] = 0;
    rgba.copy(scanlines, targetOffset + 1, row * stride, (row + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createClient(): VncClient {
  const client = new VncClient({
    debug: false,
    fps: 0,
    encodings: [
      VncClient.consts.encodings.raw,
      VncClient.consts.encodings.copyRect,
      VncClient.consts.encodings.pseudoDesktopSize,
    ],
  });
  const audioMethods = client as VncClient & {
    sendAudio?: (enable: boolean) => void;
    sendAudioConfig?: (channels: number, frequency: number) => void;
  };
  audioMethods.sendAudio = () => {
    // Lume's VNC server does not support the QEMU audio extension this client
    // enables by default. Sending it can close the VNC socket before a frame
    // arrives, so ADE disables audio for screenshot/input control sessions.
  };
  audioMethods.sendAudioConfig = () => {
    // See sendAudio above.
  };
  return client;
}

function connectVnc(connection: DirectVncConnection, timeoutMs: number): Promise<VncClient> {
  return new Promise((resolve, reject) => {
    const client = createClient();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.disconnect();
      reject(new Error(`Timed out connecting to VNC at ${connection.host}:${connection.port}.`));
    }, timeoutMs);
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.disconnect();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    client.once("authenticated", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(client);
    });
    client.once("authError", () => fail(new Error(`VNC authentication failed for ${connection.host}:${connection.port}.`)));
    client.once("connectError", fail);
    client.once("connectTimeout", () => fail(new Error(`Timed out connecting to VNC at ${connection.host}:${connection.port}.`)));
    client.connect({
      host: connection.host,
      port: connection.port,
      path: null,
      auth: {
        password: connection.password ?? "",
      },
      set8BitColor: false,
    });
  });
}

async function withVncClient<T>(
  connection: DirectVncConnection,
  timeoutMs: number,
  operation: (client: VncClient) => Promise<T>,
): Promise<T> {
  const client = await connectVnc(connection, Math.min(timeoutMs, 10_000));
  try {
    return await operation(client);
  } finally {
    client.disconnect();
  }
}

export async function captureVncScreenshot(
  connection: DirectVncConnection,
  timeoutMs = 15_000,
): Promise<DirectVncScreenshot> {
  return await withVncClient(connection, timeoutMs, async (client) => new Promise<DirectVncScreenshot>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Timed out capturing VNC screenshot from ${connection.host}:${connection.port}.`)), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      client.removeListener("firstFrameUpdate", onFrame);
      client.removeListener("frameUpdated", onFrame);
      client.removeListener("connectError", onError);
      client.removeListener("authError", onAuthError);
      client.removeListener("closed", onClosed);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      const width = Math.max(1, client.clientWidth);
      const height = Math.max(1, client.clientHeight);
      resolve({
        width,
        height,
        pngData: encodeRgbaPng(width, height, Buffer.from(client.fb)),
      });
    };
    function onFrame(): void {
      finish();
    }
    function onError(error: unknown): void {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
    function onAuthError(): void {
      finish(new Error(`VNC authentication failed for ${connection.host}:${connection.port}.`));
    }
    function onClosed(): void {
      finish(new Error(`VNC connection closed before a screenshot was captured from ${connection.host}:${connection.port}.`));
    }
    client.once("firstFrameUpdate", onFrame);
    client.once("frameUpdated", onFrame);
    client.once("connectError", onError);
    client.once("authError", onAuthError);
    client.once("closed", onClosed);
    client.requestFrameUpdate(true, 0, 0, 0, Math.max(1, client.clientWidth), Math.max(1, client.clientHeight));
  }));
}

export async function clickVnc(
  connection: DirectVncConnection,
  x: number,
  y: number,
  timeoutMs = 10_000,
): Promise<{ width: number; height: number; x: number; y: number }> {
  return await withVncClient(connection, timeoutMs, async (client) => {
    const targetX = Math.max(0, Math.min(Math.max(0, client.clientWidth - 1), Math.round(x)));
    const targetY = Math.max(0, Math.min(Math.max(0, client.clientHeight - 1), Math.round(y)));
    client.sendPointerEvent(targetX, targetY, MOUSE_LEFT_BUTTON);
    await delay(40);
    client.sendPointerEvent(targetX, targetY, 0);
    await delay(80);
    return { width: client.clientWidth, height: client.clientHeight, x: targetX, y: targetY };
  });
}

function keysymForCodePoint(codePoint: number): number {
  if (codePoint <= 0xff) return codePoint;
  return 0x01000000 | codePoint;
}

function textToKeysyms(text: string): number[] {
  const keysyms: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null) continue;
    if (char === "\n" || char === "\r") keysyms.push(0xff0d);
    else if (char === "\t") keysyms.push(0xff09);
    else if (char === "\b") keysyms.push(0xff08);
    else keysyms.push(keysymForCodePoint(codePoint));
  }
  return keysyms;
}

export async function typeTextVnc(
  connection: DirectVncConnection,
  text: string,
  timeoutMs = 30_000,
): Promise<{ width: number; height: number; typedLength: number }> {
  return await withVncClient(connection, timeoutMs, async (client) => {
    client.clientCutText(text);
    for (const keysym of textToKeysyms(text)) {
      client.sendKeyEvent(keysym, true);
      client.sendKeyEvent(keysym, false);
    }
    await delay(100);
    return { width: client.clientWidth, height: client.clientHeight, typedLength: text.length };
  });
}
