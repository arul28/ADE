# Moving the SDK packages from `@ade-dev` to `@daex-dev`

The SDK packages are published under the `@daex-dev` npm scope from 0.7.1 on:

| Old name (last version 0.7.1) | New name (first version 0.7.1) |
| --- | --- |
| `@ade-dev/sdk` | `@daex-dev/sdk` |
| `@ade-dev/chat-ui` | `@daex-dev/chat-ui` |
| `@ade-dev/demo` | `@daex-dev/demo` (private, never published) |

The code is the same apart from the rename. Every `Ade*` export (`createAdeChat`,
`AdeError`, `AdeChat`, `useAdeThread`, ...) is still exported as a deprecated
alias of its `Daex*` name, so code written against `@ade-dev` only has to change
its import specifiers.

The runtime platform packages (`@ade-dev/runtime`, `@ade-dev/runtime-*`) keep
their names for now: the SDK resolves them by that name. Do not deprecate them.

The CTO's in-process MCP server is now `daex-cto` (Claude tools
`mcp__daex-cto__<tool>`, Codex namespace `daex_cto`). A permission policy that
names `ade-cto` (`mcp:ade-cto:*`, `mcp__ade-cto__<tool>`, or `ade-cto` in
`autoApproveMcpServers`) keeps working: the runtime treats `ade-cto` as a
deprecated alias of `daex-cto`, in deny rules as well as allow rules. Label
maps in `@daex-dev/chat-ui` keyed on `mcp:ade-cto:…` keep matching too. Both
names stay reserved for `mcpServers`. Change policies to `daex-cto` when
convenient.

The steps below are for the npm owner. Run them in this order.

## 1. Before merging: create the scope and a token

1. On npmjs.com, **Add Organization** named `daex-dev` (free plan, public
   packages). Add the same maintainers as `ade-dev`.
2. Create a **granular access token** (Access Tokens, Generate New Token,
   Granular): permission **Read and write**, packages and scopes limited to the
   `@daex-dev` scope (add `@ade-dev` too if you will publish step 4 from CI;
   from your machine you do not need it), with an expiry.
3. Point the publish workflow at it. The first `@daex-dev` version cannot use
   trusted publishing, because npm only configures a trusted publisher for a
   package that already exists, and the workflow refuses OIDC for a package npm
   has never seen:

   ```bash
   gh secret set NPM_TOKEN --repo arul28/ADE          # paste the new token
   gh variable delete SDK_TRUSTED_PUBLISHING --repo arul28/ADE   # or set it to false
   ```

You can do this before or after the rename merges. The merge touches
`packages/sdk/**`, so `.github/workflows/publish-sdk-packages.yml` runs on
`main`, but it does not publish: it skips each package npm has never seen
(`@daex-dev/sdk`, `@daex-dev/chat-ui`) with a notice, so `main` stays green
while the scope and token are not ready.

## 2. Publish the first `@daex-dev` versions

A merge never publishes a package for the first time. Once step 1 is done and
the rename is on `main`, run the workflow by hand:

```bash
gh workflow run publish-sdk-packages.yml --repo arul28/ADE -f confirm=publish
```

That run publishes `@daex-dev/sdk@0.7.1` and `@daex-dev/chat-ui@0.7.1` with the
`NPM_TOKEN` from step 1. With the old token (limited to `@ade-dev`) it fails.
After the first versions exist, merges publish new versions as before.

Check both are live:

```bash
npm view @daex-dev/sdk version
npm view @daex-dev/chat-ui version
```

## 3. Switch CI back to trusted publishing

For each of `@daex-dev/sdk` and `@daex-dev/chat-ui`, on npmjs.com open the
package, **Settings**, **Trusted Publisher**, GitHub Actions: repository
`arul28/ADE`, workflow `publish-sdk-packages.yml`. Then:

```bash
gh variable set SDK_TRUSTED_PUBLISHING --repo arul28/ADE --body true
gh secret delete NPM_TOKEN --repo arul28/ADE
```

## 4. Publish a final `@ade-dev` version that re-exports `@daex-dev`

`@ade-dev/sdk@0.7.2` and `@ade-dev/chat-ui@0.7.2` depend on the new packages
and re-export them, so anyone who runs `npm update` keeps working and gets one
copy of the code. Build them in a scratch folder, not in this repository.

Three files of the SDK are copied instead of re-exported:
`dist/electron/preload.*`, `preload-auto.cjs` and `renderer.global.js` (plus the
other `dist/electron/renderer.*` and `global.*` files). A `sandbox: true`
preload can `require` nothing but `"electron"`, and a classic `<script>` cannot
import at all, so those entries must stay self-contained files.

```bash
set -euo pipefail
NEW=0.7.1     # the @daex-dev version the shims point at
SHIM=0.7.2    # one past the last @ade-dev version
WORK="$(mktemp -d)"
cd "$WORK"
npm pack "@daex-dev/sdk@$NEW" "@daex-dev/chat-ui@$NEW"
mkdir sdk chat-ui
tar -xzf "daex-dev-sdk-$NEW.tgz" -C sdk --strip-components=1
tar -xzf "daex-dev-chat-ui-$NEW.tgz" -C chat-ui --strip-components=1

# Node entries of the SDK: re-export. The electron renderer/preload files stay copies.
for pair in "index:@daex-dev/sdk" "server:@daex-dev/sdk/server" \
            "testing:@daex-dev/sdk/testing" "electron/index:@daex-dev/sdk/electron"; do
  entry="${pair%%:*}"; spec="${pair#*:}"
  printf 'export * from "%s";\n' "$spec" > "sdk/dist/$entry.js"
  printf 'export * from "%s";\n' "$spec" > "sdk/dist/$entry.d.ts"
  printf 'export * from "%s";\n' "$spec" > "sdk/dist/$entry.d.cts"
  printf 'module.exports = require("%s");\n' "$spec" > "sdk/dist/$entry.cjs"
done
rm -f sdk/dist/client-*.d.ts sdk/dist/client-*.d.cts

# chat-ui has one entry: re-export it.
printf 'export * from "@daex-dev/chat-ui";\n' > chat-ui/dist/index.js
printf 'export * from "@daex-dev/chat-ui";\n' > chat-ui/dist/index.d.ts
printf 'export * from "@daex-dev/chat-ui";\n' > chat-ui/dist/index.d.cts
printf 'module.exports = require("@daex-dev/chat-ui");\n' > chat-ui/dist/index.cjs
find chat-ui/dist -type f ! -name 'index.*' -delete

# Rename, depend on the new package, drop build scripts (prepack would rebuild).
for pkg in sdk chat-ui; do
  node -e '
    const fs = require("fs");
    const [dir, shim, target] = process.argv.slice(1);
    const file = dir + "/package.json";
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    const name = "@ade-dev/" + dir;
    const to = "@daex-dev/" + dir;
    p.name = name;
    p.version = shim;
    p.description = `Renamed to ${to}. This final version re-exports ${to}.`;
    p.dependencies = { ...(p.dependencies || {}), [to]: "^" + target };
    delete p.scripts;
    delete p.devDependencies;
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
    fs.writeFileSync(dir + "/README.md",
      `# ${name}\n\nThis package is now [\`${to}\`](https://www.npmjs.com/package/${to}).\n\n` +
      "```bash\nnpm uninstall " + name + "\nnpm install " + to + "\n```\n\n" +
      "Change your imports from `" + name + "` to `" + to + "`. The `Ade*` names still work " +
      "as deprecated aliases of the `Daex*` names.\n\n" +
      `This last version only re-exports ${to}.\n\n## License\n\nMIT. See [LICENSE](./LICENSE).\n`);
  ' "$pkg" "$SHIM" "$NEW"
done

# Sanity check before publishing: both import paths must give the same class.
mkdir check && cd check && npm init -y >/dev/null
npm install --install-links "../sdk" "../chat-ui" react react-dom >/dev/null
node --input-type=module -e '
  const a = await import("@ade-dev/sdk"); const b = await import("@daex-dev/sdk");
  if (a.DaexError !== b.DaexError || a.AdeError !== b.DaexError) throw new Error("sdk shim mismatch");
  const c = await import("@ade-dev/chat-ui"); const d = await import("@daex-dev/chat-ui");
  if (c.DaexChat !== d.DaexChat || c.AdeChat !== d.DaexChat) throw new Error("chat-ui shim mismatch");
  console.log("shims ok");'
cd ..

# Publish the SDK first: chat-ui's optional peer is the SDK.
(cd sdk && npm publish --access public)        # add --otp=<code> if npm asks
(cd chat-ui && npm publish --access public)
```

## 5. Deprecate the old names

`npm deprecate` makes every `npm install` of an old version print the message.
Deprecate all versions, the 0.7.2 shim included:

```bash
npm deprecate "@ade-dev/sdk@*" "Renamed to @daex-dev/sdk. Install @daex-dev/sdk and change your imports; the Ade* names still work as deprecated aliases."
npm deprecate "@ade-dev/chat-ui@*" "Renamed to @daex-dev/chat-ui. Install @daex-dev/chat-ui and change your imports; the Ade* names still work as deprecated aliases."
```

Check it took:

```bash
npm view @ade-dev/sdk deprecated
npm view @ade-dev/chat-ui deprecated
```

To undo a deprecation, run the same command with an empty message (`""`).
