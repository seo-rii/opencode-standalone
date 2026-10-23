import { Effect } from "effect"
import { Commands } from "../../packages/cli/src/commands/commands"
import { Runtime } from "../../packages/cli/src/framework/runtime"

export default Runtime.handler(Commands.commands.uninstall, () =>
  Effect.fail(new Error("To uninstall this distribution, stop its servers and remove the opencode-standalone.js file manually. Session data and configuration are managed separately.")),
)
