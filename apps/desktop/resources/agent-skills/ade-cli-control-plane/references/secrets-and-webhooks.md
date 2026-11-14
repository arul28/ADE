# Secrets and webhooks

## Project secrets

A project's secrets live in Passwords & Secrets: the person's vault, encrypted
on their account and synced to every computer they sign in to. A secret is
for every project or for one repository; a project sees those for every
project, then its own over them. A secret saved with `--storage device` stays
on this computer only. The person manages them in Settings › Passwords &
Secrets.

Use them only when the user names a secret or clearly asks you to use a stored
credential. You use a secret, you never read it: `ade secrets exec` runs a
command on this computer with the project's secrets in its environment and
prints its output with every value of 8 characters or more masked. A shorter
value is not masked (the command says which), so do not run a command that
prints a short secret, and never copy such output into chat or a log.
`ade secrets get` is the person's, in the ADE desktop app.

```
ade secrets list --text                 # names, where each lives, never a value
ade secrets exec -- npm run deploy      # every secret in the environment
ade secrets exec --env STRIPE_API_KEY -- sh -c 'stripe customers list --api-key "$STRIPE_API_KEY"'
ade secrets set STRIPE_API_KEY --value sk_...      # this project, every computer
printf %s "$TOKEN" | ade secrets set TOKEN --stdin
ade secrets set TOKEN --value-file token.txt
ade secrets delete STRIPE_API_KEY       # this project's own secret only
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
