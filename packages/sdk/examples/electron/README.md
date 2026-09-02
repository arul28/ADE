# ADE SDK Electron example

A minimal hardened Electron app on `@ade-dev/sdk/electron`. Three files, one per
process, and a vanilla-JavaScript transcript so nothing here is React or build
tooling.

The window runs with `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, and a strict Content Security Policy in the page. That is the
configuration a hardened product ships and the one an untested bridge breaks on.

## What it needs

Install a provider CLI first and sign in to it. The example opens the cheapest
available model in the catalog. With no provider installed it shows
"ADE knows no models" and sends nothing.

```
npm install -g @anthropic-ai/claude-code   # or another supported provider
```

## Run it

CI does not install this example. Build the SDK first, then install here.

```
cd packages/sdk
npm install
npm run build

cd examples/electron
npm install
npm start
```

`npm install` links `@ade-dev/sdk` from `file:../..`, so the example runs against
the package you just built.

## The three files

| file | process | what it does |
| --- | --- | --- |
| `main.mjs` | main | creates the SDK client and calls `registerAdeIpc` |
| `preload.cjs` | preload | exposes two functions on `window.ade` |
| `renderer/app.js` | renderer | calls `createAdeIpcClient(window.ade)` |

## Two ways to load the preload

A sandboxed preload has no module resolution: `require` reaches Electron's own
built-ins and nothing else. So a preload is either one self-contained file or it
is bundled.

By default `main.mjs` points at the SDK's own published preload:

```js
preload: require.resolve("@ade-dev/sdk/electron/preload")
```

Set `ADE_EXAMPLE_PRELOAD=local` to load `preload.cjs` next to `main.mjs`
instead. That file is hand-written, imports nothing, and is the shape to copy
when your app wants its own channels alongside ADE's.

```
ADE_EXAMPLE_PRELOAD=local npm start
```

## Attachments

`send()` takes filesystem paths, not bytes. A renderer cannot invent one: open a
dialog in the main process and send the path back. The bridge does not upload
buffers.

## Using `@ade-dev/chat-ui` instead

`createAdeIpcClient` returns the shape `adaptSdkClient` expects, with no cast:

```tsx
import { createAdeIpcClient } from "@ade-dev/sdk/electron/renderer";
import { adaptSdkClient, AdeChat } from "@ade-dev/chat-ui";

const client = adaptSdkClient(createAdeIpcClient(window.ade));

export function App() {
  return <AdeChat client={client} threadKey="main" />;
}
```

That route needs a bundler, because it imports ES modules. This example has no
bundler on purpose, which is why it loads `renderer.global.js` with a plain
`<script>` tag.
