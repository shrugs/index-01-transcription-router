// The Index 01 webhook (protocol v1): its HMAC-SHA256 signature, and the recording it carries.
// https://github.com/coredevices/mobileapp/blob/main/experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/INDEX_WEBHOOK_API.md
import { Effect, Result, Schema } from "effect"
import { Hex } from "effect/encoding"

export class InvalidSignature extends Schema.TaggedError<InvalidSignature>()("InvalidSignature", {
  message: Schema.String
}) {}

export class NoRecording extends Schema.TaggedError<NoRecording>()("NoRecording", { message: Schema.String }) {}

const MAX_SKEW_SECONDS = 5 * 60

/**
 * Checks `X-Index-Signature`: lowercase hex HMAC-SHA256(secret, "v1\n" + timestamp + "\n" + delivery + "\n" + trigger
 * + "\n" + (test ? "1" : "0") + "\n" + raw body), with the timestamp within five minutes.
 */
export const verifySignature = Effect.fn("verifySignature")(function* (
  secret: string,
  headers: Headers,
  body: Uint8Array<ArrayBuffer>
) {
  const version = headers.get("x-index-webhook-version")
  const signature = headers.get("x-index-signature") ?? ""
  const timestamp = headers.get("x-index-timestamp") ?? ""
  if (version !== "1") return yield* new InvalidSignature({ message: `unsupported webhook version ${version}` })
  if (!/^[0-9a-f]{64}$/.test(signature)) return yield* new InvalidSignature({ message: "missing signature" })
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return yield* new InvalidSignature({ message: "timestamp outside the allowed window" })
  }

  const delivery = headers.get("x-index-delivery") ?? ""
  const trigger = headers.get("x-index-trigger") ?? ""
  const test = headers.get("x-index-test") === "true" ? "1" : "0"
  const prefix = `v1\n${timestamp}\n${delivery}\n${trigger}\n${test}\n`

  const valid = yield* Effect.promise(async () => {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "verify"
    ])
    const signed = await new Blob([encoder.encode(prefix), body]).arrayBuffer()
    return crypto.subtle.verify("HMAC", key, Result.getOrThrow(Hex.decode(signature)), signed)
  })
  if (!valid) return yield* new InvalidSignature({ message: "signature does not match" })
})

/**
 * The multipart fields: `audio` (M4A, when the webhook sends recordings), `test` (test events) and `recordedAt`
 * (Unix milliseconds when the recording was captured).
 */
export const parse = Effect.fn("parse")(function* (contentType: string, body: Uint8Array<ArrayBuffer>) {
  const form = yield* Effect.promise(() => new Response(body, { headers: { "content-type": contentType } }).formData())
  const audio = form.get("audio")
  const recordedAt = Number(form.get("recordedAt"))
  return {
    test: form.get("test") === "true",
    audio: audio instanceof File ? audio : undefined,
    recordedAt: Number.isFinite(recordedAt) && recordedAt > 0 ? new Date(recordedAt) : undefined
  }
})
