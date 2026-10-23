import { runPersistentPtyDaemon } from "../persistent-pty/index.ts"

// Finish evaluating the inline bundle before the daemon dynamically loads its
// embedded Ghostty module. Awaiting the daemon here blocks those initializers.
runPersistentPtyDaemon(process.argv.slice(3)).catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 1
})
