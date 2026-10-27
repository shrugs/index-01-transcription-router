# Setup

Instructions for a coding agent setting this up for its user. Work through the steps in order. Ask the user when a step needs something only they have (accounts, keys, the phone), and run everything else yourself.

## 1. Understand the code

Read `src/index.ts` and `src/webhook.ts`. The flow is: verify the Index signature → parse the multipart body → transcribe → the block marked **What happens to the transcript** → answer. That block is the only part most users need to change. Its comments list common alternatives.

## 2. Decide what happens to transcripts

Ask the user what they want done with each recording. If they run Hermes, the default (forward to a Hermes webhook route) already works. Otherwise, edit the block to do what they describe and keep these rules:

- Every failure has to fail the effect, so the handler answers 502 and the Index app retries.
- The Worker and everything it binds to are declared in `alchemy.run.ts`, and `Cloudflare.Env` is typed from it. New config goes in the Worker's `env` as a plain string. New secrets go there as `Config.Redacted("NAME")`, which reads `NAME` from `.env`. For a new resource (D1, KV, R2, AI), wrap the Worker in `Effect.gen`, `yield*` the resource, and pass it in `env`.
- If they don't use the forwarding webhook, delete `forward` and its vars and secrets rather than leaving them unused.

Run `bun run typecheck` until it passes.

## 3. Prerequisites

- Bun (version in `.tool-versions`), then `bun install`.
- A Cloudflare account, signed in to Alchemy: have the user run `bunx alchemy profile edit --add Cloudflare`, which signs in through the browser. If it reports that no profile exists, run `bunx alchemy profile create default` first. For CI, set `CLOUDFLARE_API_TOKEN` and `CI=1` instead.
- An OpenRouter API key from https://openrouter.ai/keys (unless you switched transcription to Workers AI).
- If forwarding to Hermes: a webhook route on their Hermes gateway that's reachable from the internet (a Cloudflare Tunnel works), and that route's secret. Set `FORWARD_WEBHOOK_URL` in `alchemy.run.ts` to the route's URL. The JSON body has `transcript`, `recorded_at` (ISO time), `trigger` (the ring gesture) and `delivery` (unique per recording), which the route's prompt can reference.

## 4. Secrets and deploy

Generate the Index signing secret with `openssl rand -hex 32`, and show it to the user, since they'll paste it into the app. Put every secret in `.env` (gitignored):

```sh
WEBHOOK_SIGNING_SECRET=...
OPENROUTER_API_KEY=...
FORWARD_WEBHOOK_SECRET=...
```

Then run `bun run deploy`, which uploads the Worker along with the secrets from `.env`. Note the `*.workers.dev` URL it prints. Deploy state lives in `.alchemy/` (gitignored), so later deploys should run from the same machine.

## 5. Connect the Index app

Have the user open the Index webhook settings in the app, then:

1. Set the URL to the Worker's URL.
2. Paste the signing secret.
3. Turn on sending the recording. Without it the Worker answers 422.
4. Send a test event. The Worker should answer `{"ok":true,"test":true}`.

## 6. Verify end to end

Run `bun run logs` while the user records something with the ring. Confirm the `webhook`, `transcript` and (if forwarding) `forwarded` log lines appear, and confirm with the user that the result arrived where they wanted it. A 401 means the secret doesn't match or the phone's clock is off by more than five minutes. A 502 shows which step failed in the log.

## Local development

Run `bun run dev`, which serves the Worker on port 8787 with the secrets from `.env`, and `bun run tunnel`, then point the Index app's webhook at the tunnel URL.
