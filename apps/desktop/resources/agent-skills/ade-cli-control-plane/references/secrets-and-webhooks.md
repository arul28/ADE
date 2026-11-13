# Project secrets and webhooks

## Project secrets

ADE project secrets are encrypted, project-scoped, and shared by ADE Desktop,
the CLI, runtime-backed actions, lanes, and agents on the same machine. They live
under the active project root, not inside an individual lane worktree.

Use them only when the user names a secret or clearly asks you to use a stored
credential. You use a secret, you never read it: `ade secrets exec` runs a
command on this computer with the project's secrets in its environment (plus
any Passwords secrets for this project) and prints its output with every
value masked. `ade secrets get` is the person's, in the ADE desktop app.

```
ade secrets list --text
ade secrets pull --text                 # take this repository's account secrets out of the vault
ade secrets exec -- npm run deploy      # every secret in the environment
ade secrets exec --env STRIPE_API_KEY -- sh -c 'stripe customers list --api-key "$STRIPE_API_KEY"'
ade secrets set STRIPE_API_KEY --value sk_...
printf %s "$TOKEN" | ade secrets set TOKEN --stdin
ade secrets set TOKEN --value-file token.txt
ade secrets delete STRIPE_API_KEY
ade actions list --domain project_secret --text
```

**Never ask the user to paste a secret into chat.** When you need a key,
token, or webhook secret the project does not have yet, ask for it with the
private secret card:

```
ade secrets request GITHUB_WEBHOOK_SECRET --reason "Signs GitHub deliveries to your triage webhook" --generate
```

The chat shows the user a password field (with a "Generate a strong one"
button; `--generate` marks it as suggested). The command blocks until they
answer and prints only the outcome — `{name, saved: true}`, `{name, saved:
false, kept: true}` or `{name, saved: false, declined: true}` — never the
value. For a token a shell CLI needs that should not stay in ADE, add
`--delivery file --request-id <key>`: the user may choose a temporary private
file, and you get `{saved: true, delivery: "file", file}`. Read it only inside
a command (`TOKEN="$(cat <file>)" wrangler deploy`) and never print it; it is
deleted after 24 hours or when the chat is archived. Otherwise use the secret by name with `ade secrets exec`, e.g.
`ade secrets exec --env NAME -- sh -c 'gh secret set X --body "$NAME"'`. If the user
declines, carry on without it or explain what is blocked.

## Webhook automations

To run an agent whenever another service does something (GitHub, Stripe,
Linear, Sentry, a deploy hook), read the **ade-webhooks** skill. The short
version: `ade automations webhook create --preset github --filter
body.action=opened --in-this-chat --text` makes the URL and the rule;
`ade secrets request <NAME> --reason "…"` collects the signing secret without
it ever entering chat; `ade automations webhook deliveries <wh-id> --text`
shows what arrived and why it ran or was skipped.
