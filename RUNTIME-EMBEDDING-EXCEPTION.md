# DAEX Runtime Embedding Exception

Version 1.1, 28 November 2026 (formerly the ADE Runtime Embedding Exception,
version 1.0, 2 September 2026)

DAEX was previously named ADE. Every permission in this document applies in the
same way to binaries and packages published under the old name: the `ade`
executable, releases of `arul28/ADE`, and the `@ade-dev` npm packages.

DAEX is licensed under the GNU Affero General Public License, version 3 only
(AGPL-3.0-only). This document adds one permission on top of that license. It
does not take any permission away. Nothing here is legal advice.

## The grant

You may distribute an **unmodified DAEX runtime binary** as part of a **larger
work**, and the larger work is not, by that act alone, subject to the AGPL-3.0.
You may distribute the larger work under terms of your choice, including
proprietary terms.

This permission applies only when the larger work uses the runtime binary
through the documented public interface of the `@daex-dev/sdk` npm package (or
`@ade-dev/sdk`, its earlier name).

The runtime binary itself stays under the AGPL-3.0. This exception changes the
license of nothing else.

## What "unmodified DAEX runtime binary" means

An unmodified DAEX runtime binary is:

1. The runtime executable (`ade`, with the `daex` command beside it; `ade.exe`
   and `daex.cmd` on Windows) together with the native modules and vendored
   libraries that ship beside it, and
2. taken byte for byte from an official DAEX distribution. The official
   distributions are the assets of a GitHub release of `arul28/daex` (formerly
   `arul28/ADE`) and the `@ade-dev/runtime` and `@ade-dev/runtime-*` npm
   packages.

The following do not change the bytes and do not end this permission:

- Re-signing the binary and its native modules with your own code-signing
  identity, which macOS and Windows require of an application that bundles them.
- Copying, renaming, compressing, or archiving the files.
- Setting environment variables or command-line options that DAEX documents.

## What this exception does not cover

This exception does not apply if you:

- **Modify the runtime.** Patching, recompiling, or building the runtime from
  changed DAEX source produces a modified work. Distributing it puts the whole
  of the AGPL-3.0 back in force for the work you distribute.
- **Link DAEX source code.** Copying DAEX source into your product, or linking
  against any DAEX library other than `@daex-dev/sdk` and `@daex-dev/chat-ui`
  (or their earlier names `@ade-dev/sdk` and `@ade-dev/chat-ui`), is covered by
  the AGPL-3.0 and not by this exception.
- **Reach past the SDK.** Driving internal DAEX interfaces that `@daex-dev/sdk`
  does not document is outside this permission.

The AGPL-3.0 obligations that attach to the runtime binary itself remain. You
must still pass on the runtime's own license and the offer of its source, and
you must keep every copyright and license notice intact.

## Who may rely on it

Anyone who receives an unmodified DAEX runtime binary may rely on this
exception, whether they received it directly from DAEX or inside somebody
else's product. The permission travels with the binary.

## Related licensing

- `LICENSE` — the AGPL-3.0-only text that covers DAEX, the desktop app, the
  CLI, and the runtime binary.
- `packages/sdk/LICENSE` and `packages/chat-ui/LICENSE` — the MIT license that
  covers `@daex-dev/sdk` and `@daex-dev/chat-ui`.
- `NOTICE` — the third-party components the runtime redistributes.
- [https://ade-app.dev/docs/sdk/license](https://ade-app.dev/docs/sdk/license) — the
  per-artifact table in plain language.
