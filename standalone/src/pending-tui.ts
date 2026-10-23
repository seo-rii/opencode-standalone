import { Effect } from "effect"
import { Commands } from "../../packages/cli/src/commands/commands"
import { Runtime } from "../../packages/cli/src/framework/runtime"

export default Runtime.handler(Commands, () =>
  Effect.fail(
    new Error(
      "The native OpenTUI renderer has not been ported in this experimental standalone build. Use `run` for a prompt or `serve` for the upstream API. See standalone/COMPATIBILITY.md for the remaining work.",
    ),
  ),
)

