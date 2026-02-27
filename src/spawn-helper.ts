/**
 * Cross-platform helper for spawning the `openclaw` CLI.
 *
 * On Windows, npm global installs produce `.cmd` / `.bat` wrappers instead of
 * native executables.  Node's `child_process.execFile` and `spawn` bypass the
 * shell by default, so they cannot resolve `.cmd` files - resulting in ENOENT.
 *
 * Adding `{ shell: true }` fixes ENOENT but introduces two new problems:
 *   1. `cmd.exe` may pick up the extensionless POSIX shim before `.cmd`,
 *      causing a "node.exe is not recognized" error.
 *   2. Arguments containing spaces / emoji are re-parsed by `cmd.exe`,
 *      breaking the `-m <message>` parameter.
 *
 * This module resolves the issue by locating the actual `openclaw.mjs` entry
 * point and invoking it directly via `process.execPath` (the current Node
 * binary), completely bypassing `.cmd` wrappers and shell quoting issues.
 *
 * On non-Windows platforms the standard `"openclaw"` binary name is used
 * unchanged.
 */

import { execFile, spawn, type SpawnOptions, type ExecFileOptions } from "child_process";
import { join } from "path";
import { existsSync } from "fs";

/** Resolved once at module load time. `null` on non-Windows or if not found. */
const openclawMjs: string | null = (() => {
  if (process.platform !== "win32") return null;
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const candidate = join(appData, "npm", "node_modules", "openclaw", "openclaw.mjs");
  return existsSync(candidate) ? candidate : null;
})();

/**
 * Spawn `openclaw <args>` as a detached background process.
 * Drop-in replacement for `spawn("openclaw", args, opts)`.
 */
export function spawnOpenclaw(args: string[], opts: SpawnOptions) {
  if (openclawMjs) {
    return spawn(process.execPath, [openclawMjs, ...args], opts);
  }
  return spawn("openclaw", args, opts);
}

/**
 * Execute `openclaw <args>` and collect output.
 * Drop-in replacement for `execFile("openclaw", args, opts, cb)`.
 */
export function execFileOpenclaw(
  args: string[],
  opts: ExecFileOptions,
  cb: (error: Error | null, stdout: string, stderr: string) => void,
) {
  if (openclawMjs) {
    return execFile(process.execPath, [openclawMjs, ...args], opts, cb);
  }
  return execFile("openclaw", args, opts, cb);
}
