import { Context, Effect, Layer } from "effect"

export const methods = ["standalone"] as const
export type Method = (typeof methods)[number]
export type RunResult = { readonly type: "available" | "installed"; readonly version: string }
export type CheckResult = RunResult | { readonly type: "unavailable"; readonly message: string }

export class UpgradeError extends Error {
  readonly title = "Standalone update unavailable"
  readonly detail = "Replace the JS file with a verified new standalone build."
  readonly command = undefined
  readonly retry = this.detail
}

export class Service extends Context.Service<Service, {
  run: () => Effect.Effect<undefined>
  check: () => Effect.Effect<CheckResult>
  apply: () => Effect.Effect<never, Error>
  method: () => Effect.Effect<"standalone">
  latest: () => Effect.Effect<never, Error>
  upgrade: () => Effect.Effect<never, Error>
  removal: () => undefined
}>()("@opencode/standalone/Updater") {}

const unavailable = () => Effect.fail(new Error("Automatic installation and updates are unavailable for this experimental standalone artifact. Replace the JS file with a verified new build."))

export const layer = Layer.succeed(Service, {
  run: () => Effect.succeed(undefined),
  check: () => Effect.succeed({ type: "unavailable", message: "Replace the JS file with a verified new standalone build." }),
  apply: unavailable,
  method: () => Effect.succeed("standalone"),
  latest: unavailable,
  upgrade: unavailable,
  removal: () => undefined,
})

export * as Updater from "./updater"

