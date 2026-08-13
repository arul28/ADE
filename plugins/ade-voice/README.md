## Voice

Dictate into the composer instead of typing. Press **Dictate**, speak, and the
words are typed into your draft — transcribed by a speech model that lives on
this computer, so no audio is uploaded anywhere and dictation keeps working with
the network off.

Dictation was part of ADE itself until plugins existed. All of it moved out, and
it moved out through the front door: the button is a `composer-action` socket
any plugin can declare, the recording comes from `ade.audio.captureClip`, and
the words go back through the `{composer: {insertText}}` response any action can
return. Nothing here is reserved for plugins ADE happens to write — which is the
part worth saying out loud, because it means anyone could have built this one.

### What it adds

- A **Dictate** button beside the chat composer, on desktop and web.
- The `transcribe` action, for anything that already has a recording and wants
  words back.

### The one-time download

The speech model (`ggml-base.en.bin`, about **141 MB**) is not shipped inside the
plugin — it is downloaded the first time you dictate, from the canonical
whisper.cpp weights on Hugging Face, and verified against a pinned sha256 before
it is used. It lands in ADE's own application-support folder
(`~/Library/Application Support/ADE/whisper`), not in the plugin directory, so
updating or reinstalling the plugin never downloads it again. If you dictated in
ADE before voice became a plugin, the model is already there and this plugin
downloads nothing.

Two things follow from the size:

- **The first press does not record.** Readiness is checked before the
  microphone opens, so pressing Dictate on a machine with no model starts the
  download and says so *instead of* recording — you are never asked to say
  something twice because the plugin discovered halfway through that it could
  not transcribe it. The panel shows progress; every press after that records.
- **An interrupted download resumes.** Quitting mid-download, or losing the
  network, costs you the bytes still in flight and nothing more. The file is
  only named as the model once its checksum matches, so a half-finished download
  can never look like a working one.

### Apple Silicon, Intel, and everything else

The speech engine shipped here is a macOS binary — a universal build, so it runs
on both Apple Silicon and Intel Macs. **There is no Linux or Windows build in
this package.** On those platforms the plugin installs and its panel says so
plainly, and any attempt to transcribe fails with a clear message rather than a
silence. This is an honest limitation, not a temporary one: adding a platform
means adding a binary to `bin/` and a line to the table in `engine.js`.

### English

The bundled model is `base.en`, which is English-only. A `language` other than
English is accepted by the action and passed through to the engine, but an
English-only model will translate rather than transcribe it — for other
languages the model would have to be a multilingual one, which this package does
not ship.

### The glossary

`voice-glossary.json` ships with the plugin and does two jobs. Its
`contextualTerms` are handed to the speech engine as a decoding hint, so words
this crowd actually says — lane, worktree, cr-sqlite — are recognized rather
than guessed at. Its `corrections` and `fillers` then run over the transcript:
"um" and "you know" come out, known mishearings are fixed, sentences are
capitalized. Nothing in that pass is a model or a network call, so the same
recording always produces the same text.

The file's schema is shared with ADE's iOS app, which runs the same passes on
its own dictation. Edit it here and the two drift apart, so change both.

### Privacy, stated plainly

Your voice goes to a temporary file, is transcribed by a process on this
machine, and the file is deleted. Nothing is sent to a server, including ADE's.
The only network request this plugin ever makes is the one-time model download.

### For callers

The Dictate button invokes `dictate`, which records and returns
`{composer: {insertText}}` — a cancelled recording returns quietly, and a clip
with no words in it says so.

Anything that already has a recording wants `transcribe` instead, through ADE's
own action:

```bash
ade actions run plugin.invoke --input-json '{
  "pluginId": "ade-voice",
  "action": "transcribe",
  "args": {
    "audioPath": "/tmp/recording.wav",
    "language": "en",
    "glossary": ["SwiftUI", "cr-sqlite"]
  }
}'
```

`audioPath` is a wav, mp3, flac or ogg file on this machine; `language` and
`glossary` are optional; the result is `{ "text": "…" }`.

`glossary` is a list of words this particular recording is likely to contain —
project names, tools, people. They go to the engine ahead of the packaged
glossary's own terms, and any that come back spelled differently are rewritten
to the spelling you gave.

Two more actions exist for anything that wants to show state: `status` returns
readiness and download progress as data, and `prepare` starts the model download
and returns immediately.

### When something goes wrong

Every failure is a plain sentence, and they are distinct on purpose: a model
still downloading, a download that failed, a microphone already in use, a
recording that is missing or empty, a clip with no speech in it, a damaged model
(which is deleted so the next attempt re-downloads it), a recording too long to
transcribe inside one request, and a platform with no engine. Whichever you hit,
the composer shows you that sentence.

Logs are in `ade plugin logs ade-voice --text`.

### Credits

The speech engine is [whisper.cpp](https://github.com/ggerganov/whisper.cpp) by
Georgi Gerganov and the ggml authors, and the model is OpenAI's Whisper
`base.en`, converted to ggml by that project. Both are MIT; the full notices are
in `NOTICE` beside this file.
