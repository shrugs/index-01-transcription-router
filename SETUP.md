# Setup

Instructions for a coding agent setting this up for its user. Work through the steps in order. Ask the user when a step needs something only they have (accounts, keys, the phone), and run everything else yourself.

## 1. Understand the code

Read `src/index.ts` and `src/webhook.ts`. The flow is: verify the Index signature → parse the multipart body → transcribe → the block marked **What happens to the transcript** → answer. That block is the only part most users need to change. Its comments list common alternatives.

## 2. Decide what happens to transcripts

Ask the user what they want done with each recording. If they run Hermes, the default (forward to a Hermes webhook route) already works. Otherwise, edit the block to do what they describe and keep these rules:

- Every failure has to fail the effect, so the handler answers 502 and the Index app retries.
- New config goes in `wrangler.jsonc` `vars`, new secrets go in `src/env.d.ts` and get set with `wrangler secret put`, and new bindings (D1, KV, R2, AI) go in `wrangler.jsonc`.
- If they don't use the forwarding webhook, delete `forward` and its vars and secrets rather than leaving them unused.

Run `bun run typecheck` until it passes.

## 3. Prerequisites

- Bun (version in `.tool-versions`), then `bun install`.
- A Cloudflare account: `bunx wrangler login`. If the user has several accounts, add `account_id` to `wrangler.jsonc`.
- An OpenRouter API key from https://openrouter.ai/keys (unless you switched transcription to Workers AI).
- If forwarding to Hermes: a webhook route on their Hermes gateway that's reachable from the internet (a Cloudflare Tunnel works), and that route's secret. Set `FORWARD_WEBHOOK_URL` in `wrangler.jsonc` to the route's URL. The JSON body has `transcript`, `recorded_at` (ISO time), `trigger` (the ring gesture) and `delivery` (unique per recording), which the route's prompt can reference.

## 4. Secrets and deploy

Generate the Index signing secret with `openssl rand -hex 32`, and show it to the user, since they'll paste it into the app. Then:

```sh
bunx wrangler secret put WEBHOOK_SIGNING_SECRET
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put FORWARD_WEBHOOK_SECRET
bun run deploy
```

Note the `*.workers.dev` URL that deploy prints.

## 5. Connect the Index app

Have the user open the Index webhook settings in the app, then:

1. Set the URL to the Worker's URL.
2. Paste the signing secret.
3. Turn on sending the recording. Without it the Worker answers 422.
4. Send a test event. The Worker should answer `{"ok":true,"test":true}`.

## 6. Verify end to end

Run `bunx wrangler tail` while the user records something with the ring. Confirm the `webhook`, `transcript` and (if forwarding) `forwarded` log lines appear, and confirm with the user that the result arrived where they wanted it. A 401 means the secret doesn't match or the phone's clock is off by more than five minutes. A 502 shows which step failed in the log.

## Local development

Put the same secrets in `.env` (gitignored), then run `bun run dev` and `bun run tunnel`, and point the Index app's webhook at the tunnel URL.
