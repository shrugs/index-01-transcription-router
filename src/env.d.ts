// `Cloudflare.Env`, typed from the bindings declared in alchemy.run.ts.
type AlchemyEnv = import("@alchemy.run/cloudflare").InferEnv<typeof import("../alchemy.run.ts").Worker>

declare namespace Cloudflare {
  interface Env extends AlchemyEnv {}
}
