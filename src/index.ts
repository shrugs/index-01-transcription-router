// One endpoint: a signed webhook carrying an Index 01 recording → a transcript → whatever you do with it (by default,
// a signed webhook to Hermes, which acts on it in the background).
import { Effect, Layer, Schema } from "effect"
import { Worker, WorkerEnvironment } from "effect-cf"
import { NoRecording, parse, verifySignature } from "./webhook.ts"

// Any OpenAI-compatible transcription model on OpenRouter. This could equally be Cloudflare's own Workers AI speech-to-
// text (`@cf/openai/whisper-large-v3-turbo`): add an `ai` binding to wrangler.jsonc and call `env.AI.run(...)` with the
// recording's base64 audio instead of fetching OpenRouter, which drops the OPENROUTER_API_KEY secret.
const MODEL = "openai/whisper-large-v3-turbo"

class TranscriptionFailed extends Schema.TaggedError<TranscriptionFailed>()("TranscriptionFailed", {
  message: Schema.String
}) {}

const transcribe = Effect.fn("transcribe")(function* (apiKey: string, file: File) {
  const form = new FormData()
  form.append("model", MODEL)
  form.append("file", file)
  const response = yield* Effect.promise(() =>
    fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form
    })
  )
  if (!response.ok) {
    const detail = yield* Effect.promise(() => response.text())
    return yield* new TranscriptionFailed({ message: `${response.status}: ${detail}` })
  }
  const { text } = yield* Effect.promise(() => response.json<{ text: string }>())
  return text
})

class ForwardFailed extends Schema.TaggedError<ForwardFailed>()("ForwardFailed", { message: Schema.String }) {}

const hmacHex = (secret: string, data: string) =>
  Effect.promise(async () => {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign"
    ])
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)))
    return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")
  })

/**
 * POSTs the transcript as JSON to `FORWARD_WEBHOOK_URL`, signed with Hermes's generic V2 webhook scheme (hex
 * HMAC-SHA256 of `<timestamp>.<body>` with `FORWARD_WEBHOOK_SECRET`), so it works as-is against a Hermes webhook route
 * and is easy to verify from any other receiver (n8n, Home Assistant, your own server). `X-Request-ID` is the Index
 * delivery ID, so a receiver can skip a retried delivery it already handled.
 */
const forward = Effect.fn("forward")(function* (
  env: Cloudflare.Env,
  event: { transcript: string; recordedAt: Date | undefined; trigger: string | null; delivery: string | null }
) {
  const body = JSON.stringify({
    transcript: event.transcript,
    recorded_at: event.recordedAt?.toISOString() ?? "an unknown time",
    trigger: event.trigger ?? "unknown gesture",
    delivery: event.delivery
  })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = yield* hmacHex(env.FORWARD_WEBHOOK_SECRET, `${timestamp}.${body}`)
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(env.FORWARD_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature-v2": signature,
          ...(event.delivery ? { "x-request-id": event.delivery } : {})
        },
        body,
        signal
      }),
    catch: (error) => new ForwardFailed({ message: String(error) })
  }).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.fail(new ForwardFailed({ message: "no answer within 20 s" }))
    })
  )
  const reply = yield* Effect.promise(() => response.text())
  if (!response.ok) return yield* new ForwardFailed({ message: `${response.status}: ${reply}`.slice(0, 2000) })
  yield* Effect.log("forwarded", reply)
})

const handle = Effect.gen(function* () {
  const request = yield* Worker.NativeRequest
  const env = yield* WorkerEnvironment
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })

  const body = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()))
  yield* Effect.log("webhook", {
    trigger: request.headers.get("x-index-trigger"),
    delivery: request.headers.get("x-index-delivery"),
    bytes: body.byteLength
  })

  yield* verifySignature(env.WEBHOOK_SIGNING_SECRET, request.headers, body)
  const { test, audio: file, recordedAt } = yield* parse(request.headers.get("content-type") ?? "", body)
  if (test) return Response.json({ ok: true, test: true })
  if (!file) return yield* new NoRecording({ message: "no audio field; set the webhook to send the recording" })
  yield* Effect.log("transcribing", { name: file.name, type: file.type, bytes: file.size })
  const transcript = yield* transcribe(env.OPENROUTER_API_KEY, file)
  yield* Effect.log("transcript", transcript)

  // ── What happens to the transcript ───────────────────────────────────────────────────────────────────────────────
  // This is the part to make your own. By default every transcript goes to one signed webhook (Hermes). Any failure
  // here should fail the effect: the handler then answers 502 and the Index app retries the delivery later.
  //
  // Some things to do instead, or as well:
  // - Route by what was said: test the transcript for a spoken keyword and only forward when it's there, e.g.
  //   `if (/(?<![\p{L}\p{N}])hermes(?![\p{L}\p{N}])/iu.test(transcript)) yield* forward(...)`, with a different
  //   destination for everything else.
  // - Forward to several places at once: run the legs with `Effect.all({ a, b }, { concurrency: "unbounded",
  //   mode: "result" })` so one failing doesn't stop the others, then answer 502 if any failed.
  // - Post to a chat: a Slack or Discord incoming webhook is one `fetch` with `{ text: transcript }`.
  // - Keep a journal: append to a D1 table, a KV key per day or an R2 object (add the binding to wrangler.jsonc), or
  //   create a page/task in Notion, Todoist, Linear or GitHub Issues through their APIs.
  // - Post-process first: summarize, title or extract to-dos with an LLM (OpenRouter's chat completions with the same
  //   key, or Workers AI) and send that along with the raw transcript.
  // - Keep the audio: put `file` in R2 next to its transcript.
  yield* forward(env, {
    transcript,
    recordedAt,
    trigger: request.headers.get("x-index-trigger"),
    delivery: request.headers.get("x-index-delivery")
  })
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  return Response.json({ ok: true, characters: transcript.length })
}).pipe(
  Effect.tapError(Effect.logWarning),
  Effect.catchTags({
    InvalidSignature: (error) => Effect.succeed(new Response(error.message, { status: 401 })),
    NoRecording: (error) => Effect.succeed(new Response(error.message, { status: 422 })),
    TranscriptionFailed: (error) => Effect.succeed(new Response(error.message, { status: 502 })),
    ForwardFailed: (error) => Effect.succeed(new Response(error.message, { status: 502 }))
  }),
  Effect.tapCause(Effect.logError)
)

export default Worker.makeFetchHandler(Layer.empty, { fetch: handle })
