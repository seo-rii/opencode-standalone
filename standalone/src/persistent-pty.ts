export const available = process.platform === "linux"

export async function resolveBinary(_directory?: string): Promise<string> {
  if (!available) throw new Error("Persistent terminals currently require the Linux standalone PTY adapter")
  return process.execPath
}

