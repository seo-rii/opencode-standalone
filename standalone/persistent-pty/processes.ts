import { closeSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"

type Process = { pid: number; parent: number; group: number; session: number; start: bigint; state: string }
type Identity = Process & { fd: number }
type FFI = {
  getInt32(pointer: number | bigint): number
  dlopen(file: null, definitions: Record<string, { arguments: string[]; return: string }>): {
    lib: { close(): void }
    functions: {
      prctl(option: number, arg2: bigint, arg3: bigint, arg4: bigint, arg5: bigint): number
      syscall(call: bigint, arg1: bigint, arg2: bigint, arg3: null, arg4: number): bigint
      waitid(type: number, id: number, status: Uint8Array, options: number): number
      __errno_location(): number | bigint
    }
  }
}

/** Dedicated-daemon ownership: stable process handles, never stored numeric PGID signals. */
export function createProcessOwners() {
  const ffi = createRequire(import.meta.url)("node:ffi") as FFI
  const native = ffi.dlopen(null, {
    prctl: { arguments: ["i32", "u64", "u64", "u64", "u64"], return: "i32" },
    syscall: { arguments: ["i64", "i64", "i64", "pointer", "u32"], return: "i64" },
    waitid: { arguments: ["i32", "u32", "pointer", "i32"], return: "i32" },
    __errno_location: { arguments: [], return: "pointer" },
  })
  const errno = () => ffi.getInt32(native.functions.__errno_location())
  // pidfd_open/send_signal have the same syscall numbers on Linux x64/arm64.
  // Using libc's syscall avoids requiring glibc's newer pidfd wrapper exports.
  const open = (pid: number) => Number(native.functions.syscall(434n, BigInt(pid), 0n, null, 0))
  const signal = (fd: number) => {
    if (native.functions.syscall(424n, BigInt(fd), 9n, null, 0) === 0n || errno() === 3) return
    throw new Error(`failed to signal owned terminal process: errno ${errno()}`)
  }
  const probe = open(process.pid)
  if (probe < 0) { native.lib.close(); throw new Error("persistent PTY cleanup requires Linux pidfd wait support (kernel 5.4 or later)") }
  const waitProbe = native.functions.waitid(3, probe, Buffer.alloc(128), 5)
  const waitError = errno()
  closeSync(probe)
  // Our own process is not our child: ECHILD proves P_PIDFD was understood.
  if (waitProbe !== 0 && waitError !== 10) {
    native.lib.close()
    throw new Error("persistent PTY cleanup requires Linux pidfd wait support (kernel 5.4 or later)")
  }
  if (native.functions.prctl(36, 1n, 0n, 0n, 0n) !== 0) {
    native.lib.close()
    throw new Error("failed to enable persistent PTY child subreaping")
  }
  const sessions = new Map<number, symbol>()
  return {
    close: () => native.lib.close(),
    create(pid: number) {
      const retained = pin(pid)
      if (!retained) throw new Error("PTY shell exited before its identity could be retained")
      const shell = retained
      if (shell.parent !== process.pid || shell.group !== pid || shell.session !== pid) {
        closeSync(shell.fd)
        throw new Error("PTY shell does not own its expected session")
      }
      const generation = Symbol()
      sessions.set(shell.session, generation)
      const members = new Map([[shell.pid, shell]])
      let exited = false
      let finished = false

      function retain(candidate: Process, parent: number) {
        if (candidate.parent !== parent || candidate.session !== shell.session || candidate.start < shell.start) return
        const previous = members.get(candidate.pid)
        if (previous?.start === candidate.start) return previous
        const identity = pin(candidate.pid, candidate)
        if (!identity) return
        if (previous) closeSync(previous.fd)
        members.set(identity.pid, identity)
        return identity
      }
      function descend(identity: Identity, visited: Set<number>) {
        if (visited.has(identity.pid) || !present(identity)) return
        visited.add(identity.pid)
        const children = childPids(identity.pid)
        if (!present(identity)) return
        for (const pid of children) {
          const child = info(pid)
          if (!child) continue
          const retained = retain(child, identity.pid)
          if (retained) descend(retained, visited)
        }
      }
      function capture(initialExit = false) {
        if (finished) return
        const anchors = [...members.values()].filter((identity) => present(identity))
        // After the raw exit callback, new identities require an existing
        // retained member of this session. An empty, recycled SID is never ours.
        if (!anchors.length && !(initialExit && sessions.get(shell.session) === generation)) return
        const leader = info(shell.pid)
        if (initialExit && leader && leader.start !== shell.start) return
        const visited = new Set<number>()
        for (const identity of anchors) descend(identity, visited)
        for (const pid of childPids(process.pid)) {
          if (pid === shell.pid) continue
          const child = info(pid)
          if (!child) continue
          const retained = retain(child, process.pid)
          if (retained) descend(retained, visited)
        }
      }
      function remove(identity: Identity) {
        if (members.get(identity.pid) !== identity) return
        members.delete(identity.pid)
        closeSync(identity.fd)
      }
      function reap(identity: Identity) {
        const current = present(identity)
        if (!current) { remove(identity); return }
        if (current.parent !== process.pid) return
        const status = Buffer.alloc(128)
        // P_PIDFD, WEXITED | WNOHANG. Linux's 64-bit siginfo_t stores si_pid
        // at byte 16. Waiting on the handle cannot reap a recycled numeric PID.
        if (native.functions.waitid(3, identity.fd, status, 5) === 0) {
          if (status.readInt32LE(16) !== 0) remove(identity)
          return
        }
        if (errno() === 4) return
        if (errno() === 10 && !present(identity)) { remove(identity); return }
        throw new Error(`failed to reap owned terminal process: errno ${errno()}`)
      }
      return {
        captureExited() {
          if (exited) return
          exited = true
          capture(true)
        },
        kill() {
          capture()
          for (const identity of members.values()) signal(identity.fd)
        },
        async reap() {
          // The PTY adapter's logical exit means Node reaped the original shell.
          // Its handle is retained until then but must never be waited here.
          remove(shell)
          const deadline = performance.now() + 5_000
          while (members.size) {
            capture()
            for (const identity of members.values()) signal(identity.fd)
            const current = [...members.values()]
            const anchor = current.find((identity) => present(identity))
            // Keep one owned child unreaped while discovering later orphans.
            // Its session reference prevents that SID from being recycled.
            for (const identity of current) if (identity !== anchor) reap(identity)
            if (anchor && members.size === 1 && present(anchor)?.state === "Z") {
              capture()
              if (members.size === 1) reap(anchor)
            }
            if (!members.size) break
            if (performance.now() >= deadline) throw new Error("terminal background processes did not exit")
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
          finished = true
          if (sessions.get(shell.session) === generation) sessions.delete(shell.session)
        },
      }
    },
  }

  function pin(pid: number, expected = info(pid)): Identity | undefined {
    if (!expected) return
    const fd = open(pid)
    if (fd < 0) { if (errno() === 3) return; throw new Error(`failed to retain terminal process identity: errno ${errno()}`) }
    const current = info(pid)
    if (!current || current.start !== expected.start || current.session !== expected.session || current.parent !== expected.parent) {
      closeSync(fd)
      return
    }
    return { ...current, fd }
  }
}

function info(pid: number): Process | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: BigInt(fields[19]) }
  } catch { return }
}

function present(identity: Identity) {
  const current = info(identity.pid)
  return current?.start === identity.start && current.session === identity.session ? current : undefined
}

function childPids(pid: number) {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).map(Number).filter((child) => child > 0) } catch { return [] }
}
