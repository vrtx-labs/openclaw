import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveKeybaseAccount } from "./accounts.js";
import { clearLiveBot, deinitKeybaseBot, initKeybaseBot, setLiveBot } from "./bot-client.js";
import { handleKeybaseInbound } from "./inbound.js";
import { isKeybaseTeamTarget } from "./normalize.js";
import { getKeybaseRuntime } from "./runtime.js";
import type { CoreConfig, KeybaseAttachment, KeybaseInboundMessage } from "./types.js";

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
}): { target: string; isGroup: boolean; isTeamChannel: boolean } {
  const { channel, senderUsername } = params;
  const membersType = channel.membersType ?? "";
  // Team channels.
  if (membersType === "team" || membersType === "impteam") {
    const topic = channel.topicName ? `#${channel.topicName}` : "#general";
    return { target: `team:${channel.name}${topic}`, isGroup: true, isTeamChannel: true };
  }
  // impteamnative group chats: channel.name is comma-separated participants.
  if (membersType === "impteamnative" && channel.name.includes(",")) {
    const participants = channel.name.split(",").map((s) => s.trim());
    if (participants.length > 2) {
      // Multi-person group chat — use the full channel name as target, not a team channel.
      return { target: channel.name, isGroup: true, isTeamChannel: false };
    }
  }
  // 1:1 DM — reply to sender directly.
  return { target: senderUsername, isGroup: false, isTeamChannel: false };
}

export async function monitorKeybaseProvider(
  opts: KeybaseMonitorOptions,
): Promise<{ stop: () => void }> {
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

  /** Default max attachment size in bytes (20 MB). */
  const mediaMaxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;

  // watchAllChannelsForNewMessages returns a Promise that resolves when the
  // internal listen process exits. We race it against the abort signal.
  const listenPromise = bot.chat.watchAllChannelsForNewMessages(
    async (msg) => {
      if (stopped) {
        return;
      }

      const content = msg.content;
      if (!content) {
        return;
      }

      const isText = content.type === "text" && Boolean(content.text?.body?.trim());
      const isAttachment = content.type === "attachment";

      // Skip messages that are neither text nor attachment.
      if (!isText && !isAttachment) {
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

      const { target, isGroup, isTeamChannel } = buildInboundTarget({
        channel: rawChannel,
        senderUsername,
      });

      // Resolve message text (attachment title serves as caption).
      const text = isText
        ? (content.text?.body?.trim() ?? "")
        : (content.attachment?.object?.title?.trim() ?? "");

      // Download attachments to a temp directory.
      let attachments: KeybaseAttachment[] | undefined;
      let tempDir: string | undefined;

      if (isAttachment && content.attachment) {
        const asset = content.attachment.object;
        const mimeType = asset?.mimeType ?? "application/octet-stream";
        // Derive a safe filename from the asset; voice messages often have no filename.
        const ext =
          mimeType === "video/mp4"
            ? ".mp4"
            : mimeType === "image/jpeg"
              ? ".jpg"
              : mimeType === "image/png"
                ? ".png"
                : mimeType === "audio/ogg"
                  ? ".ogg"
                  : ".bin";
        const rawFilename = asset?.filename?.trim() ?? "";
        const filename = rawFilename && rawFilename !== "." ? rawFilename : `attachment${ext}`;
        const fileSize = asset?.size ?? 0;

        const isSupportedMime =
          mimeType.startsWith("image/") ||
          mimeType.startsWith("audio/") ||
          mimeType.startsWith("video/"); // Keybase sends audio recordings as video/mp4

        // Only process supported attachments within size limit.
        if (isSupportedMime && fileSize <= mediaMaxBytes) {
          try {
            const { chmod } = await import("node:fs/promises");
            // Step 1: download into /tmp (world-writable, vrtxbot can write here).
            const tmpDownloadDir = join(tmpdir(), `keybase-dl-${randomUUID()}`);
            await mkdir(tmpDownloadDir, { recursive: true });
            await chmod(tmpDownloadDir, 0o777);
            const tmpPath = join(tmpDownloadDir, filename);
            await bot.chat.download(rawChannel, msg.id, tmpPath);

            // Step 2: copy into the OpenClaw media dir (root-owned, agent sandbox allows it).
            const mediaDir = join(homedir(), ".openclaw", "media", "keybase", randomUUID());
            await mkdir(mediaDir, { recursive: true });
            const finalPath = join(mediaDir, filename);
            await copyFile(tmpPath, finalPath);

            // Clean up tmp download.
            rm(tmpDownloadDir, { recursive: true, force: true }).catch(() => {});

            tempDir = mediaDir;
            attachments = [{ localPath: finalPath, mimeType, filename }];
          } catch (err) {
            logger.error(
              `[${account.accountId}] attachment download failed (msg ${msg.id}): ${err instanceof Error ? err.message : String(err)}`,
            );
            // Clean up on failure only.
            if (tempDir) {
              rm(tempDir, { recursive: true, force: true }).catch(() => {});
              tempDir = undefined;
            }
          }
        } else if (!isSupportedMime) {
          runtime.log?.(
            `keybase: skipping unsupported attachment (${mimeType}) from ${senderUsername}`,
          );
          return;
        } else {
          runtime.log?.(
            `keybase: skipping oversized attachment (${fileSize} bytes) from ${senderUsername}`,
          );
          return;
        }
      }

      // Skip if nothing to process.
      if (!text && (!attachments || attachments.length === 0)) {
        return;
      }

      const message: KeybaseInboundMessage = {
        messageId: String(msg.id),
        target,
        senderUsername,
        text,
        timestamp: msg.sentAt ? msg.sentAt * 1000 : Date.now(),
        isGroup,
        isTeamChannel,
        rawChannel,
        attachments,
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
      // Note: attachment temp dirs are intentionally NOT cleaned up here — the
      // agent run is async and may still be accessing the file. The OS will
      // reclaim /tmp on reboot. A future improvement could schedule deferred cleanup.
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
