import { Bot } from "@vrtx-labs/keybase-bot";
import { resolveKeybaseAccount } from "./accounts.js";
import { getLiveBot, initKeybaseBot, deinitKeybaseBot } from "./bot-client.js";
import { normalizeKeybaseTarget, isKeybaseTeamTarget } from "./normalize.js";
import { getKeybaseRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

export type SendKeybaseResult = {
  messageId: string;
  target: string;
};

type SendKeybaseOptions = {
  accountId?: string;
};

/**
 * Build a Keybase ChatChannel descriptor from a canonical target string.
 *   DM:    "alice"              -> { name: "alice", membersType: "impteamnative" }
 *   Team:  "myteam#general"   -> { name: "myteam", membersType: "team", topicName: "general" }
 */
function buildChatChannel(target: string): {
  name: string;
  membersType: string;
  topicName?: string;
} {
  if (isKeybaseTeamTarget(target)) {
    const hashIdx = target.indexOf("#");
    if (hashIdx === -1) {
      // Team with no topic - fall back to "general".
      return { name: target, membersType: "team", topicName: "general" };
    }
    return {
      name: target.slice(0, hashIdx),
      membersType: "team",
      topicName: target.slice(hashIdx + 1),
    };
  }
  return { name: target, membersType: "impteamnative" };
}

export async function sendMessageKeybase(
  to: string,
  text: string,
  opts: SendKeybaseOptions = {},
): Promise<SendKeybaseResult> {
  const runtime = getKeybaseRuntime();
  const cfg = runtime.config.loadConfig() as CoreConfig;
  const account = resolveKeybaseAccount({ cfg, accountId: opts.accountId });

  if (!account.configured) {
    throw new Error(
      `Keybase is not configured for account "${account.accountId}" (need username and paperkey in channels.keybase).`,
    );
  }

  const normalized = normalizeKeybaseTarget(to);
  if (!normalized) {
    throw new Error(`Invalid Keybase target: ${to}`);
  }

  const payload = text.trim();
  if (!payload) {
    throw new Error("Message must be non-empty for Keybase sends");
  }

  const channel = buildChatChannel(normalized);

  // Prefer live bot from the running monitor; fall back to a transient bot.
  let bot = getLiveBot(account.accountId);
  let transient = false;
  if (!bot) {
    bot = await initKeybaseBot(account);
    transient = true;
  }

  let msgId = 0;
  try {
    const result = await bot.chat.send(channel, { body: payload });
    msgId = result.id ?? 0;
  } finally {
    if (transient) {
      await deinitKeybaseBot(bot as Bot, account.accountId);
    }
  }

  runtime.channel.activity.record({
    channel: "keybase",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: String(msgId || Date.now()),
    target: normalized,
  };
}
