/**
 * A small Chrome DevTools Protocol client for the demo film capture: start a
 * headless Chrome, open one page, send commands, and drive real input (the
 * pointer and the keyboard), so the app reacts exactly as it does to a person.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchChrome({ width, height }) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ade-film-chrome-"));
  const child = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 15_000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", () => reject(new Error("Chrome exited")));
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  const client = await connect(page.webSocketDebuggerUrl);
  return {
    client,
    async close() {
      try {
        await client.send("Browser.close");
      } catch {
        child.kill("SIGTERM");
      }
      await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(`${data.error.message} ${data.error.data ?? ""}`));
      else resolve(data.result);
    } else if (data.method) {
      for (const listener of listeners.get(data.method) ?? []) listener(data.params);
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
  };
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
};

/** Real input and page helpers on one CDP client. */
export function pageTools(client) {
  return {
    async evaluate(expression) {
      const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async press(key) {
      const spec = KEYS[key];
      if (!spec) throw new Error(`unknown key ${key}`);
      const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
      await client.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}) });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async typeChar(char) {
      const upper = char.toUpperCase();
      const keyCode = /[a-z0-9]/i.test(char) ? upper.charCodeAt(0) : char === " " ? 32 : 0;
      const base = { key: char, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: char, unmodifiedText: char });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async mouse(type, x, y, { button = "none", clickCount = 0 } = {}) {
      await client.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount, buttons: button === "left" ? 1 : button === "right" ? 2 : 0 });
    },
    async wheel(x, y, deltaY) {
      await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    },
  };
}
