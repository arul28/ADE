/**
 * scrcpy's control socket: the messages ADE sends to the pinned server.
 *
 * Every message is one type byte and a fixed big-endian body. Layouts come
 * from `app/src/control_msg.c` (client) and `server/.../ControlMessageReader.java`
 * (server) at tag v3.3.4. A message the server cannot parse ends its control
 * thread, so the encoders here write exactly those layouts and nothing else.
 *
 * Positions are in **video** pixels with the video size beside them. The
 * server maps them to the display itself, and it drops an event whose size is
 * not the current video size (the device may have rotated since the event was
 * made). `androidStream.ts` converts device pixels to video pixels.
 */

import type { Socket } from "node:net";

import type { AndroidHardwareKey } from "../../../shared/types/androidEmulator";

const TYPE_INJECT_KEYCODE = 0;
const TYPE_INJECT_TEXT = 1;
const TYPE_INJECT_TOUCH_EVENT = 2;
const TYPE_BACK_OR_SCREEN_ON = 4;
const TYPE_RESET_VIDEO = 17;

/** `KeyEvent.ACTION_*`. */
const KEY_ACTION = { down: 0, up: 1 } as const;
/** `MotionEvent.ACTION_*`. */
const MOTION_ACTION = { down: 0, up: 1, move: 2 } as const;

/**
 * The pointer id scrcpy uses for a touch that is not a real finger (its mouse
 * emulation). The server gives it its own pointer slot, so it never collides
 * with ids 0..9 from a multi-touch caller.
 */
export const SCRCPY_POINTER_ID_GENERIC_FINGER = -2n;

/** The server reads at most this many UTF-8 bytes of one text message. */
export const SCRCPY_INJECT_TEXT_MAX_BYTES = 300;

/** Android key codes (`KeyEvent.KEYCODE_*`) for the rail's keys. */
export const ANDROID_HARDWARE_KEYCODES: Record<AndroidHardwareKey, number> = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
  volume_up: 24,
  volume_down: 25,
};

export function encodeInjectKeycode(args: {
  action: keyof typeof KEY_ACTION;
  keycode: number;
  repeat?: number;
  metaState?: number;
}): Buffer {
  const buffer = Buffer.alloc(14);
  buffer.writeUInt8(TYPE_INJECT_KEYCODE, 0);
  buffer.writeUInt8(KEY_ACTION[args.action], 1);
  buffer.writeInt32BE(args.keycode, 2);
  buffer.writeInt32BE(args.repeat ?? 0, 6);
  buffer.writeInt32BE(args.metaState ?? 0, 10);
  return buffer;
}

/**
 * Back that also wakes the screen: the server presses POWER when the display
 * is off and BACK when it is on, so the rail's Back never lands on a dark
 * screen and does nothing.
 */
export function encodeBackOrScreenOn(action: keyof typeof KEY_ACTION): Buffer {
  return Buffer.from([TYPE_BACK_OR_SCREEN_ON, KEY_ACTION[action]]);
}

/** One down + up pair for a hardware key. */
export function encodeHardwareKeyPress(key: AndroidHardwareKey): Buffer[] {
  if (key === "back") return [encodeBackOrScreenOn("down"), encodeBackOrScreenOn("up")];
  const keycode = ANDROID_HARDWARE_KEYCODES[key];
  return [encodeInjectKeycode({ action: "down", keycode }), encodeInjectKeycode({ action: "up", keycode })];
}

/**
 * Text as one or more inject-text messages.
 *
 * The server truncates a message at 300 bytes, so longer text is split, and
 * only between code points: a cut inside a UTF-8 sequence would inject a
 * replacement character.
 */
export function encodeInjectText(text: string): Buffer[] {
  const messages: Buffer[] = [];
  let part = "";
  let partBytes = 0;
  const flush = () => {
    if (!part) return;
    const body = Buffer.from(part, "utf8");
    const message = Buffer.alloc(5 + body.byteLength);
    message.writeUInt8(TYPE_INJECT_TEXT, 0);
    message.writeUInt32BE(body.byteLength, 1);
    body.copy(message, 5);
    messages.push(message);
    part = "";
    partBytes = 0;
  };
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (partBytes + charBytes > SCRCPY_INJECT_TEXT_MAX_BYTES) flush();
    part += char;
    partBytes += charBytes;
  }
  flush();
  return messages;
}

export function encodeInjectTouch(args: {
  action: keyof typeof MOTION_ACTION;
  /** Non-negative for a real finger; `SCRCPY_POINTER_ID_GENERIC_FINGER` otherwise. */
  pointerId: bigint;
  /** Video pixels. */
  x: number;
  y: number;
  /** The video size the position is relative to. */
  videoWidth: number;
  videoHeight: number;
  /** 0..1. Defaults to 1 while the finger is down and 0 on up. */
  pressure?: number;
}): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt8(TYPE_INJECT_TOUCH_EVENT, 0);
  buffer.writeUInt8(MOTION_ACTION[args.action], 1);
  buffer.writeBigInt64BE(args.pointerId, 2);
  buffer.writeInt32BE(Math.round(args.x), 10);
  buffer.writeInt32BE(Math.round(args.y), 14);
  buffer.writeUInt16BE(args.videoWidth, 18);
  buffer.writeUInt16BE(args.videoHeight, 20);
  const pressure = Math.min(1, Math.max(0, args.pressure ?? (args.action === "up" ? 0 : 1)));
  // u16 fixed point, with 1.0 saturating at 0xffff as the client does.
  buffer.writeUInt16BE(Math.min(0xffff, Math.trunc(pressure * 0x10000)), 22);
  // A finger has no buttons; the server clears them for finger events anyway.
  buffer.writeInt32BE(0, 24);
  buffer.writeInt32BE(0, 28);
  return buffer;
}

/**
 * Asks the server to restart its capture and encoder. The restart sends a new
 * config packet and opens with a keyframe, which is how a reader that joins
 * mid-stream gets a frame it can decode now instead of at the next periodic
 * keyframe (10 s on the server's default).
 */
export function encodeResetVideo(): Buffer {
  return Buffer.from([TYPE_RESET_VIDEO]);
}

export type ScrcpyControlWriter = {
  /** Writes the messages in order. Rejects when the socket is gone. */
  send(messages: readonly Uint8Array[]): Promise<void>;
  isOpen(): boolean;
};

/**
 * Writes control messages to the server's control socket.
 *
 * The server also writes to this socket (clipboard and UHID replies). ADE asks
 * for neither, but the bytes are still read and dropped so a reply can never
 * fill the socket buffer and stall the server's sender thread.
 */
export function createScrcpyControlWriter(socket: Socket): ScrcpyControlWriter {
  let open = !socket.destroyed;
  socket.setNoDelay(true);
  socket.on("data", () => {});
  socket.on("close", () => {
    open = false;
  });
  return {
    send(messages): Promise<void> {
      if (!open || socket.destroyed) {
        return Promise.reject(new Error("The emulator's control connection is closed."));
      }
      const payload = messages.length === 1 ? messages[0] : Buffer.concat(messages);
      return new Promise((resolve, reject) => {
        socket.write(payload, (error) => (error ? reject(error) : resolve()));
      });
    },
    isOpen(): boolean {
      return open && !socket.destroyed;
    },
  };
}
