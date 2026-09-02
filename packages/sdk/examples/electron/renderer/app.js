/**
 * The whole renderer. No React, no build step — the point is the bridge, not
 * the view. `@ade-dev/chat-ui` drops in here unchanged: `adaptSdkClient(client)`
 * accepts this exact object, because `createAdeIpcClient` returns the shape it
 * expects with no cast.
 */

/* global AdeElectron */

const client = AdeElectron.createAdeIpcClient(window.ade);

const transcript = document.getElementById("transcript");
const state = document.getElementById("state");
const composer = document.getElementById("composer");
const prompt = document.getElementById("prompt");

/** One row per assistant message id, so streamed chunks fold into one line. */
const messages = new Map();
let thread = null;

function addRow(className, text) {
  const row = document.createElement("div");
  row.className = className;
  row.textContent = text;
  transcript.append(row);
  transcript.scrollTop = transcript.scrollHeight;
  return row;
}

function renderEnvelope(envelope) {
  const event = envelope.event || {};
  if (event.type === "user_message") {
    addRow("row-user", `You: ${event.displayText || event.text || ""}`);
    return;
  }
  if (event.type === "text") {
    const id = event.messageId || envelope.timestamp;
    let row = messages.get(id);
    if (!row) {
      row = addRow("row-text", "");
      messages.set(id, row);
    }
    // Providers send either growing snapshots or deltas. Taking the longer of
    // the two collapses both correctly.
    const next = String(event.text || "");
    row.textContent = next.length >= row.textContent.length ? next : row.textContent + next;
    transcript.scrollTop = transcript.scrollHeight;
    return;
  }
  if (event.type === "error") {
    addRow("row-error", `Error: ${event.message || "the turn failed"}`);
  }
}

async function pickModel() {
  const models = await client.models.list();
  const usable = models.filter((model) => model.isAvailable !== false);
  const chosen = usable[0] || models[0];
  if (!chosen) throw new Error("ADE knows no models. Install and sign in to a provider CLI.");
  return chosen;
}

async function start() {
  const model = await pickModel();
  thread = await client.threads.open("main", { provider: model.provider, model: model.id });

  // Subscribe BEFORE reading history. The renderer half merges the overlap, so
  // an envelope emitted while the request was in flight arrives exactly once.
  thread.on("event", renderEnvelope);
  thread.on("status", (envelope) => {
    const turnStatus = envelope.event && envelope.event.turnStatus;
    state.textContent = turnStatus === "started" ? "Working…" : `Ready — ${model.displayName}`;
  });

  for (const envelope of await thread.history()) renderEnvelope(envelope);
  state.textContent = `Ready — ${model.displayName}`;
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || !thread) return;
  prompt.value = "";
  addRow("row-user", `You: ${text}`);
  try {
    await thread.send(text);
  } catch (error) {
    // `error.code` survived the process boundary; the class did not have to.
    addRow("row-error", `${error.code || "error"}: ${error.message}`);
  }
});

start().catch((error) => {
  state.textContent = `Could not start: ${error.message}`;
});
