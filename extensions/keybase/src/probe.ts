import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveKeybaseAccount } from "./accounts.js";
import type { CoreConfig, KeybaseProbe } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Probe Keybase availability by running `keybase version`.
 * Does not attempt to log in; just checks the binary is present and runnable.
 */
export async function probeKeybase(
  cfg: CoreConfig,
  opts: { accountId?: string; timeoutMs?: number } = {},
): Promise<KeybaseProbe> {
  const start = Date.now();
  const account = resolveKeybaseAccount({ cfg, accountId: opts.accountId });
  const binary = account.keybasePath ?? "keybase";
  const timeoutMs = opts.timeoutMs ?? 10_000;

  try {
    const { stdout } = await execFileAsync(binary, ["version", "--format", "s"], {
      timeout: timeoutMs,
    });
    const version = stdout.trim().split(/\s+/).pop() ?? stdout.trim();
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      latencyMs,
      version,
      username: account.configured ? account.username : undefined,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      latencyMs,
    };
  }
}
