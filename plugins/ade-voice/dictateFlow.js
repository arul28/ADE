// What pressing Dictate does, with the machine taken out of it.
//
// The order of these four steps is the whole design, and it is the part worth
// testing without a microphone, a model, or a Mac — so it lives here, taking
// its collaborators as arguments, and `index.js` supplies the real ones.
//
// Read it as four claims:
//
//   1. Readiness is proven BEFORE the microphone opens. A machine with no
//      speech model must never record a paragraph it will then have to throw
//      away — the user is told to wait while they still have their silence.
//   2. A cancelled recording is a success. The user pressed stop; showing them
//      an error for getting exactly what they asked for is a bug.
//   3. Silence is reported, not inserted. An empty insert is a no-op the user
//      cannot distinguish from a broken button, so it earns its own sentence.
//   4. The clip is discarded on EVERY path out — transcribed, empty, or
//      thrown. That is the `finally`, and it is what makes the package's
//      privacy sentence true in the failure cases too, which are the ones
//      nobody checks.

"use strict";

const { noSpeechError } = require("./engine");

/**
 * @param ensureReady  Throws the plain-words reason this machine cannot dictate.
 * @param capture      Resolves the clip, or null when the user cancelled.
 * @param transcribe   Turns a clip path into `{text}`.
 * @param discard      Deletes the clip. Called on every exit, awaited.
 * @param onCancelled  Optional note for the log; never shown to the user.
 */
async function runDictate({ ensureReady, capture, transcribe, discard, onCancelled }) {
  await ensureReady();

  const clip = await capture();
  if (!clip) {
    onCancelled?.();
    return { cancelled: true };
  }

  try {
    const { text } = await transcribe(clip.audioPath);
    if (!text) throw noSpeechError();
    return { composer: { insertText: text } };
  } finally {
    await discard(clip.audioPath);
  }
}

module.exports = { runDictate };
