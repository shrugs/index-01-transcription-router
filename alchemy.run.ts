// The Worker, as an alchemy stack. `bun run dev` serves it locally (workerd, state under .alchemy/); `bun run deploy`
// ships it to transcription-router.<subdomain>.workers.dev, the URL the Index app's webhook points at.
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import { localState } from "alchemy/State"
import { Config, Effect } from "effect"

// src/env.d.ts types `Cloudflare.Env` from this Worker's `env`, so a new binding only goes here. To bind a resource
// (D1, KV, R2, AI), wrap this in `Effect.gen`, `yield*` the resource, and pass it in `env`.
export const Worker = Cloudflare.Worker("Worker", {
  name: "transcription-router",
  main: "./src/index.ts",
  env: {
    // Where transcripts are forwarded, e.g. a Hermes webhook route.
    FORWARD_WEBHOOK_URL: "https://hermes.example.com/webhooks/transcription",
    // Secrets, from the environment (.env): the OpenRouter key, the Index app's webhook secret, and the receiver's
    // secret (e.g. the Hermes route's).
    OPENROUTER_API_KEY: Config.Redacted("OPENROUTER_API_KEY"),
    WEBHOOK_SIGNING_SECRET: Config.Redacted("WEBHOOK_SIGNING_SECRET"),
    FORWARD_WEBHOOK_SECRET: Config.Redacted("FORWARD_WEBHOOK_SECRET")
  },
  compatibility: { date: "2026-10-01" },
  observability: { enabled: true },
  dev: { port: 8787, strictPort: true }
})

export default Alchemy.Stack(
  "transcription-router",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    const worker = yield* Worker
    return { url: worker.url }
  })
)
