import path from "node:path"

export function parseBuildProfile(argv) {
  const args = []
  let profile
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--") {
      args.push(...argv.slice(index))
      break
    }
    if (argument !== "--profile" && !argument.startsWith("--profile=")) {
      args.push(argument)
      continue
    }
    const value = argument === "--profile" ? argv[++index] : argument.slice("--profile=".length)
    if (!value || value.startsWith("--")) throw new Error("Missing --profile value; expected full or lite")
    if (value !== "full" && value !== "lite") throw new Error("Unknown standalone profile: " + value)
    if (profile && profile !== value) throw new Error("Conflicting standalone profiles: " + profile + " and " + value)
    profile = value
  }
  return { profile: profile ?? "full", args }
}

export function distributionDirectory(directory, profile = "full") {
  if (profile !== "full" && profile !== "lite") throw new Error("Unknown standalone profile: " + profile)
  return profile === "lite" ? path.join(directory, "dist/lite") : path.join(directory, "dist")
}
