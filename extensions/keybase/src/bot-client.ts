import { Bot } from "@vrtx-labs/keybase-bot";
import type { ResolvedKeybaseAccount } from "./types.js";

/**
 * Per-account live Bot instance registry.
 * Key: accountId. Value: initialized Bot or null when not yet initialized.
 *
 * Each gateway session owns exactly one Bot per account. The monitor
 * initializes the Bot at start and deinits it on stop, so the map entry
 * is set by monitorKeybaseProvider and cleared after deinit.
 */
const liveBots = new Map<string, Bot>();

/** Store a live Bot instance for an account. Called by monitor after init. */
export function setLiveBot(accountId: string, bot: Bot): void {
  liveBots.set(accountId, bot);
}

/** Retrieve the live Bot instance for an account (for outbound sends). */
export function getLiveBot(accountId: string): Bot | undefined {
  return liveBots.get(accountId);
}

/** Remove the Bot registry entry after deinit. */
export function clearLiveBot(accountId: string): void {
  liveBots.delete(accountId);
}

/**
 * Initialize a new Keybase Bot for the given account.
 * Uses oneshot login via paper key - no persistent session files.
 */
export async function initKeybaseBot(account: ResolvedKeybaseAccount): Promise<Bot> {
  const bot = new Bot();
  await bot.init(account.username, account.paperkey, {
    verbose: false,
    keybaseBinaryLocation: account.keybasePath,
  });
  return bot;
}

/**
 * Gracefully deinit a Bot. Logs but does not throw on errors so the
 * monitor's finally block can always complete cleanup.
 */
export async function deinitKeybaseBot(bot: Bot, accountId: string): Promise<void> {
  try {
    await bot.deinit();
  } catch (err) {
    // Swallow - deinit errors should not mask the original stop reason.
    const msg = err instanceof Error ? err.message : String(err);
    // Use stderr directly since we may not have a logger reference here.
    process.stderr.write(`[keybase] deinit error for ${accountId}: ${msg}\n`);
  }
}
