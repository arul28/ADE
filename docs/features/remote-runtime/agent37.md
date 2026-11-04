# Agent 37 machines

Agent 37 sells persistent Linux machines ("boxes", and VMs) metered by the
minute and driven by a workspace API key. ADE treats it as an integration next
to GitHub, Linear and Jira: connect a key once, and **New Agent 37 machine** in
Add a computer makes a box that runs ADE's brain, signs in to the person's ADE
account with nothing to type, and appears under Your computers. From then on
it is an ordinary remote machine (relay, LAN or tailnet; see
[README](README.md)). The product plan, the measurements behind it and the
phases still to build (machine cards, ADE-owned sleep, fork and move, `ade`
verbs for agents) are in
[docs/plans/agent37-integration.md](../../plans/agent37-integration.md).

Everything here is account-level: it acts on the Agent 37 workspace and the
ADE account, never on a lane, chat or another machine, so none of these IPC
calls take a pin. They run in the desktop main process of the computer the
person is using.

## Source file map

- `apps/desktop/src/main/services/agent37/agent37Client.ts` — the Agent 37
  control plane (`api.agent37.com/v1`) and exec (`sandbox.agent37.app/v1`) for
  one key. Every failure is an `Agent37Error` keyed on Agent 37's stable
  `error.code`, with a sentence a person can act on. The key is only a header:
  never logged, never in an error. The request timeout covers the response
  body too.
- `agent37Credential.ts` — where the key lives: the account vault item
  (`all` / `integration` / `agent37`) when signed in, else this computer's
  shared credential file (`agent37.apiKey.v1`), which the desktop, the brain
  and the CLI all read. `removeAgent37Key` refuses (and keeps every copy) when
  the account confirms it holds the key and will not let go; when the account
  can't be read it removes this computer's copy and says the account copy is
  unverified. Also the connect card's status/save adapter, used by the brain
  (`adeActions/registry.ts`).
- `agent37TemplateBuilder.ts` — builds ADE's template in the person's
  workspace (see below).
- `agent37MachineCreator.ts` — `createAgent37Machine`, the New Agent 37
  machine flow.
- `agent37PendingCreates.ts` — the on-disk record of creates not yet
  resolved, the startup reconcile, and `readAgent37BoxSignedIn`.
- `registerAgent37Ipc.ts` — the `ade.agent37.*` IPC handlers, the hidden
  approval window, the template-build record store (account vault with a
  per-computer fallback), and the startup check 20 s after boot.
- `apps/desktop/src/shared/agent37.ts` — shapes, prices, kinds, status and
  progress types shared with the renderer.
- `apps/desktop/src/renderer/components/settings/Agent37Section.tsx` — the
  Agent 37 page under Settings › Integrations (key, wallet, template state,
  Retry, Disconnect).
- `apps/desktop/src/renderer/components/remoteTargets/NewAgent37MachineForm.tsx`,
  `useAgent37Template.ts`, `agent37Brand.tsx` — the create form in Add a
  computer, its template status, and Agent 37's real logo (monochrome; never
  invented art).
- `infra/agent37/` — the template's Dockerfile and entrypoint (shipped in the
  app as the `agent37-template` resource) and a manual build script.
- `apps/ade-cli/src/services/sync/hostInstanceGuard.ts` — the copied-home
  guard a forked box needs (see below).
- `apps/ade-cli/src/serviceManager/detachedSupervisor.ts` — `ade brain
  start/stop/restart` on Linux without systemd (an Agent 37 box has none).

## The template

Agent 37 templates are per workspace, so a workspace that has never seen ADE
has nothing to make a box from. Saving the key, and every app start with a key
saved, runs the builder: it reads the template and, when it is missing or was
built for an older ADE release, runs Agent 37's cloud build over its REST API
(create a build, upload the gzipped context, start, poll). No CLI and no local
Docker.

- What a template installs is in its description, `ADE <version> · template
  <hash>`, so every computer reads the same answer. A release build replaces a
  template with no marker, other template files or an older ADE; a newer one
  stays. A development or alpha build bakes the newest release and only ever
  creates a missing template.
- Two computers can check at once, and the account vault has no
  compare-and-set. A build only runs once it is uploaded and started, so the
  builder claims before that: it writes the build-in-flight record, waits five
  seconds, and reads it back. Another computer's claim for the same template
  whose build was made first wins, and this computer follows that build; its
  own is never uploaded or started (Agent 37 cannot cancel a build, so an
  unstarted one is left behind). A record that can't be read, or a claim that
  didn't land, stops the pass and retries: unknown is never "nobody is
  building".
- A finished build is ready only once Agent 37 shows the template with this
  build's marker (ADE sets it when the build published without one). Until
  then the record stays, so a later pass resumes.
- Failures retry after 1, 5 and 15 minutes, then wait for Retry. A refused key
  or an empty wallet does not retry.

## New Agent 37 machine

1. Everything that can fail before money is spent is checked first: the
   template is usable, the account service is configured, this computer is
   signed in to ADE.
2. The create is written to this computer's credential file **before** the
   request goes out, under a request id that ADE also puts in the box's
   metadata (`ade_request_id`). If it can't be written, no box is made.
3. Agent 37 answers once the box is running. ADE waits for the brain (the
   box's main process), runs `ade login --headless` on it over exec, and
   approves the code with its own account through the account directory's
   `POST /device/approve`, which answers with a one-time sign-in link. The
   link opens in a private, hidden window that is shown only if the page
   stops on something the person must confirm. The account token never leaves
   this process and nothing durable is planted on the box.
4. ADE waits for the box's row in the account list, gives it the chosen name
   and connects. A box that is signed in but not ready by the deadline is a
   partial result: the picker keeps watching for its row.

Cancel (Cancel, closing the dialog, or the window going away) reaches every
step, including the approval request. A box that never signed in is only a
bill, so any failure deletes it, and the record goes only once Agent 37
confirms the deletion.

### Half-made boxes

A create can end without ADE knowing the box's id: a lost answer, an app quit
mid-request, a failed list or delete. The pending record covers all of them.
Whoever finds it (the create's own failure path, or the next app start)
reconciles it: it lists the workspace's boxes by `ade_request_id`, and for
each one asks the box `ade auth status`:

- **signed out** (or no ADE on the box at all, exit 127): deleted;
- **signed in**: a real machine, kept;
- **unknown** (asleep, unreachable, timed out, an answer ADE can't read):
  kept, with its record, for the next start. A box that may be someone's real
  machine is never deleted on a guess.

A record that matches no box is kept for a day, in case Agent 37 still had
the create in flight, then dropped. Boxes made by another request id (another
computer's create, or not ADE's) are never touched.

## The copied-home guard

Agent 37's fork copies the whole disk, so a forked box would come up as the
machine it was copied from: same relay key, device id, account session and
every project's cr-sqlite site id. ADE's template sets
`ADE_HOST_INSTANCE_ID=agent37:<hostname>`, and `ade serve` calls
`guardAgainstCopiedAdeHome` first. The brain records the id beside its
identity; a later start with a different id moves `secrets/` aside to
`copied-identities/` (never deleted) and retires each registered project's
`.ade/secrets/sync-site-id`, so the box starts signed out as a new machine and
keeps every file. Until every site id is retired the brain refuses to serve,
and the next start finishes what is left. Without the variable the guard does
nothing, so a renamed laptop is never mistaken for a copy.

## Logging and analytics

Failures log under `agent37.*` (desktop main) and `host_instance.*` (the
brain), never with the key, the account token or the approval link (the
window logs host and path only). A finished create records one coarse product
fact, `ade_feature_used` with `feature: "connections"`, `action:
"agent37_machine_create"` and `completed`, `partial`, `cancelled` or `failed`;
see [docs/logging.md](../../logging.md).
