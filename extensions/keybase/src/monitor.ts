import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveKeybaseAccount } from "./accounts.js";
import { clearLiveBot, deinitKeybaseBot, initKeybaseBot, setLiveBot } from "./bot-client.js";
import { handleKeybaseInbound } from "./inbound.js";
import { isKeybaseTeamTarget } from "./normalize.js";
import { getKeybaseRuntime } from "./runtime.js";
import type { CoreConfig, KeybaseInboundMessage } from "./types.js";

export type KeybaseMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

function buildInboundTarget(params: {
  channel: { name: string; membersType?: string; topicName?: string };
  senderUsername: string;
}): { target: string; isGroup: boolean } {
  const { channel, senderUsername } = params;
  const membersType = channel.membersType ?? "";
  // Team messages: membersType is "team" or similar.
  if (membersType === "team" || membersType === "impteam") {
    const topic = channel.topicName ? `#${channel.topicName}` : "#general";
    return { target: `team:${channel.name}${topic}`, isGroup: true };
  }
  // DM: use sender username.
  return { target: senderUsername, isGroup: false };
}

export async function monitorKeybaseProvider(opts: KeybaseMonitorOptions): Promise<{ stop: () => void }> {
  const core = getKeybaseRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveKeybaseAccount({ cfg, accountId: opts.accountId });

  if (!account.configured) {
    throw new Error(
      `Keybase is not configured for account "${account.accountId}" (need username and paperkey in channels.keybase).`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "keybase",
    accountId: account.accountId,
  });

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args: unknown[]) => logger.info(args.map(String).join(" ")),
    error: (...args: unknown[]) => logger.error(args.map(String).join(" ")),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  logger.info(`[${account.accountId}] initializing Keybase bot as ${account.username}`);

  const bot = await initKeybaseBot(account);
  setLiveBot(account.accountId, bot);

  logger.info(`[${account.accountId}] Keybase bot ready, listening for messages`);

  // abortSignal integration: resolve a promise when aborted so we can race it.
  let resolveAbort: () => void = () => {};
  const abortPromise = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      resolveAbort();
    } else {
      opts.abortSignal.addEventListener("abort", resolveAbort, { once: true });
    }
  }

  let stopped = false;

  // watchAllChannelsForNewMessages returns a Promise that resolves when the
  // internal listen process exits. We race it against the abort signal.
  const listenPromise = bot.chat.watchAllChannelsForNewMessages(
    async (msg) => {
      if (stopped) {
        return;
      }

      // Only handle text messages.
      const content = msg.content;
      if (!content || content.type !== "text" || !content.text?.body?.trim()) {
        return;
      }

      const rawChannel = {
        name: msg.channel.name,
        membersType: msg.channel.membersType,
        topicName: msg.channel.topicName,
      };

      const senderUsername = msg.sender?.username ?? "";
      if (!senderUsername) {
        return;
      }

      const { target, isGroup } = buildInboundTarget({
        channel: rawChannel,
        senderUsername,
      });

      const message: KeybaseInboundMessage = {
        messageId: String(msg.id),
        target,
        senderUsername,
        text: content.text.body.trim(),
        timestamp: msg.sentAt ? msg.sentAt * 1000 : Date.now(),
        isGroup,
        rawChannel,
      };

      core.channel.activity.record({
        channel: "keybase",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });

      opts.statusSink?.({ lastInboundAt: message.timestamp });

      try {
        await handleKeybaseInbound({ message, account, config: cfg, runtime });
      } catch (err) {
        logger.error(
          `[${account.accountId}] inbound handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    (err) => {
      if (!stopped) {
        logger.error(`[${account.accountId}] Keybase listen error: ${err.message}`);
      }
    },
  );

  // Race: either the listen process exits or we get an abort signal.
  await Promise.race([listenPromise, abortPromise]);
  stopped = true;

  // Cleanup.
  try {
    clearLiveBot(account.accountId);
    await deinitKeybaseBot(bot, account.accountId);
    logger.info(`[${account.accountId}] Keybase bot stopped`);
  } catch (err) {
    logger.error(
      `[${account.accountId}] cleanup error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    stop: () => {
      // Signal abort so that the race resolves if it has not already.
      stopped = true;
      resolveAbort();
    },
  };
}

// Re-export for tree-shaking friendliness.
export { isKeybaseTeamTarget };
