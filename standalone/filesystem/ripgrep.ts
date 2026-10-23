export * as Ripgrep from "./ripgrep.js"

import { Context, Effect, Layer, Schema } from "effect"
import { Entry, Match } from "@opencode/schema/filesystem"
import { RelativePath } from "@opencode/schema/schema"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Location } from "@opencode/core/location"
import { files, grep, PatternError, type GlobInput, type GrepInput } from "./search.ts"

export type { GlobInput, GrepInput }

export class Error extends Schema.TaggedError<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedError<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput extends GlobInput {
  readonly exclude?: readonly string[]
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Ripgrep") {}

const failure = (cause: unknown) =>
  new Error({ message: cause instanceof globalThis.Error ? cause.message : String(cause), cause })

const find = (input: GlobInput & { exclude?: readonly string[]; find?: boolean }) =>
  Effect.tryPromise({
    try: (cancel) =>
      files({ ...input, signal: input.signal ? AbortSignal.any([input.signal, cancel]) : cancel }).then((entries) =>
        entries.map((entry) => Entry.make({ ...entry, path: RelativePath.make(entry.path) })),
      ),
    catch: failure,
  })

const local = Service.of({
  glob: find,
  find: (input) =>
    find({ ...input, find: true }).pipe(
      Effect.tap((entries) =>
        input.onEntry ? Effect.forEach(entries, input.onEntry, { discard: true }) : Effect.void,
      ),
    ),
  grep: (input) =>
    Effect.tryPromise({
      try: (cancel) =>
        grep({ ...input, signal: input.signal ? AbortSignal.any([input.signal, cancel]) : cancel }).then((matches) =>
          matches.map((match) =>
            Match.make({
              ...match,
              entry: Entry.make({ ...match.entry, path: RelativePath.make(match.entry.path) }),
            }),
          ),
        ),
      catch: (cause) =>
        cause instanceof PatternError
          ? new InvalidPatternError({ pattern: cause.pattern, message: cause.message })
          : failure(cause),
    }),
})

export const layer = Layer.succeed(Service, local)

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      if (!location.workspaceID) return local
      const unsupported = () =>
        Effect.fail(new Error({ message: "Standalone file search does not support remote workspaces yet" }))
      return Service.of({ find: unsupported, glob: unsupported, grep: unsupported })
    }),
  ),
  deps: [Location.node],
})
