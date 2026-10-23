export * as Git from "./index.ts"

import { Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { AbsolutePath, RelativePath } from "../../packages/core/src/schema.ts"
import { OperationError, Repository, Service, TreeID, Worktree, WorktreeError } from "virtual:upstream-git"
import {
  branch, capture, checkoutRemoteBranch, clone, create, createWorktree, defaultRemoteBranch, diff, discover,
  fetchBranch, fetchRemotes, files, head, ignored, listWorktrees, pack, refresh, remote, removeWorktree, resetHard,
  restore, rootCommits, write,
} from "./backend.ts"
import type { Repository as BackendRepository } from "./backend.ts"

export { OperationError, Repository, Service, TreeID, Worktree, WorktreeError }
export type { CaptureInput, Interface } from "virtual:upstream-git"

const operation = <A>(name: OperationError["operation"], directory: AbsolutePath, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OperationError({ operation: name, directory, message: cause instanceof Error ? cause.message : String(cause), cause }),
  })

const asRepository = (value: BackendRepository) => new Repository({
  worktree: AbsolutePath.make(value.worktree),
  gitDirectory: AbsolutePath.make(value.gitDirectory),
  commonDirectory: AbsolutePath.make(value.commonDirectory),
})

const worktreeOperation = <A>(name: WorktreeError["operation"], directory: AbsolutePath, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WorktreeError({
      operation: name, directory, message: cause instanceof Error ? cause.message : String(cause), cause,
      forceRequired: cause instanceof Error && "forceRequired" in cause && cause.forceRequired === true,
    }),
  })

export const layer = Layer.succeed(Service, Service.of({
  repo: {
    discover: (directory) => Effect.promise(async () => {
      const found = await discover(directory)
      return found ? asRepository(found) : undefined
    }),
    create: (input) => operation("create", input.worktree, async () => asRepository(await create(input))),
    clone: (input) => operation("clone", input.directory, async () => asRepository(await clone(input))),
  },
  remote: { get: (repository, name) => Effect.promise(() => remote(repository, name)) },
  history: {
    head: (repository) => Effect.promise(() => head(repository)),
    branch: (repository) => Effect.promise(() => branch(repository)),
    defaultRemoteBranch: (repository, name) => Effect.promise(() => defaultRemoteBranch(repository, name)),
    rootCommits: (repository) => Effect.promise(() => rootCommits(repository)),
  },
  sync: {
    fetchRemotes: (repository, input) => operation("fetch", repository.worktree, () => fetchRemotes(repository, input)),
    fetchBranch: (repository, input) => operation("fetch", repository.worktree, () => fetchBranch(repository, input)),
    checkoutRemoteBranch: (repository, input) => operation("checkout", repository.worktree, () => checkoutRemoteBranch(repository, input)),
    resetHard: (repository, revision) => operation("reset", repository.worktree, () => resetHard(repository, revision)),
  },
  worktree: {
    create: (input) => worktreeOperation("create", input.directory, async () => asRepository(await createWorktree(input))),
    remove: (input) => worktreeOperation("remove", input.directory, () => removeWorktree(input)),
    list: (repository) => worktreeOperation("list", repository.worktree, async () =>
      (await listWorktrees(repository)).map((value) => new Worktree({ directory: AbsolutePath.make(value.directory), kind: value.kind }))),
  },
  index: {
    refresh: (input) => operation("refresh", input.repository.worktree, async () => ({
      skipped: (await refresh(input)).skipped.map((file) => RelativePath.make(file)),
    })),
    ignored: (input) => operation("list_files", input.repository.worktree, async () => new Set([...await ignored(input)].map((file) => RelativePath.make(file)))),
  },
  tree: {
    capture: (input) => operation("write_tree", input.repository.worktree, async () => TreeID.make(await capture(input))),
    write: (repository) => operation("write_tree", repository.worktree, async () => TreeID.make(await write(repository))),
    files: (input) => operation("list_files", input.repository.worktree, async () => (await files(input)).map((file) => RelativePath.make(file))),
    diff: (input) => operation("diff", input.repository.worktree, () => diff(input)),
    restore: (input) => operation("restore", input.repository.worktree, () => restore(input)),
  },
  objects: {
    pack: (repository) => operation("pack", repository.worktree, () => pack(repository)),
  },
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
