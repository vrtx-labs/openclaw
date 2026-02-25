import {
  GROUP_POLICY_BLOCKED_LABEL,
  createReplyPrefixOptions,
  logInboundDrop,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveControlCommandGate,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { normalizeKeybaseAllowEntry } from "./normalize.js";
import { getKeybaseRuntime } from "./runtime.js";
import { sendMessageKeybase } from "./send.js";
import type { CoreConfig, KeybaseInboundMessage, ResolvedKeybaseAccount } from "./types.js";

const CHANNEL_ID = "keybase" as const;

function normalizeKeybaseAllowlist(raw?: Array<string | number>): string[] {
  if (!raw?.length) {
    return [];
  }
  return raw.map((e) => normalizeKeybaseAllowEntry(String(e))).filter(Boolean);
}

function allowlistMatch(allowFrom: string[], sender: string): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const lower = sender.toLowerCase();
  return allowFrom.some((entry) => entry === lower || lower.endsWith(`@${entry}`));
}

async function deliverKeybaseReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  target: string;
  accountId: string;
}): Promise<void> {
  const text = params.payload.text ?? "";
  const mediaList = params.payload.mediaUrls?.length
    ? params.payload.mediaUrls
    : params.payload.mediaUrl
      ? [params.payload.mediaUrl]
      : [];

  if (!text.trim() && mediaList.length === 0) {
    return;
  }

  const mediaBlock = mediaList.map((url) => `Attachment: ${url}`).join("\n");
  const combined = text.trim()
    ? mediaBlock
      ? `${text.trim()}\n\n${mediaBlock}`
      : text.trim()
    : mediaBlock;

  await sendMessageKeybase(params.target, combined, { accountId: params.accountId });
}

export async function handleKeybaseInbound(params: {
  message: KeybaseInboundMessage;
  account: ResolvedKeybaseAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { message, account, config, runtime } = params;
  const core = getKeybaseRuntime();

  const rawBody = message.text?.trim() ?? "";
  const hasAttachments = (message.attachments?.length ?? 0) > 0;

  // Skip messages with neither text nor attachments.
  if (!rawBody && !hasAttachments) {
    return;
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.keybase !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "keybase",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (msg) => runtime.log?.(msg),
  });

  const configAllowFrom = normalizeKeybaseAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeKeybaseAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom =
    dmPolicy === "allowlist"
      ? []
      : await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => []);
  const storeAllowList = normalizeKeybaseAllowlist(storeAllowFrom as Array<string>);

  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowList].filter(Boolean);
  const effectiveGroupAllowFrom = [...configGroupAllowFrom, ...storeAllowList].filter(Boolean);

  if (message.isGroup) {
    // Group policy gate.
    if (groupPolicy === "disabled") {
      runtime.log?.(`keybase: drop group ${message.target} (groupPolicy=disabled)`);
      return;
    }
    if (groupPolicy === "allowlist") {
      // Team channels: check the teams allowlist config.
      // Non-team group chats (multi-user DMs): skip the teams check — use sender gate only.
      if (message.isTeamChannel) {
        const teamKey = message.target.replace(/^team:/, "");
        const teams = account.config.teams ?? {};
        const hasEntry =
          Object.prototype.hasOwnProperty.call(teams, teamKey) ||
          Object.prototype.hasOwnProperty.call(teams, "*");
        if (!hasEntry) {
          runtime.log?.(`keybase: drop group ${message.target} (not in teams allowlist)`);
          return;
        }
      }
    }
    // Sender gate for groups.
    if (effectiveGroupAllowFrom.length > 0) {
      if (!allowlistMatch(effectiveGroupAllowFrom, message.senderUsername)) {
        runtime.log?.(
          `keybase: drop group sender ${message.senderUsername} (not in groupAllowFrom)`,
        );
        return;
      }
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`keybase: drop DM from ${message.senderUsername} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const allowed = allowlistMatch(effectiveAllowFrom, message.senderUsername);
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            id: message.senderUsername.toLowerCase(),
            meta: { name: message.senderUsername },
          });
          if (created) {
            try {
              const reply = core.channel.pairing.buildPairingReply({
                channel: CHANNEL_ID,
                idLine: `Your Keybase username: ${message.senderUsername}`,
                code,
              });
              await deliverKeybaseReply({
                payload: { text: reply },
                target: message.senderUsername,
                accountId: account.accountId,
              });
            } catch (err) {
              runtime.error?.(
                `keybase: pairing reply failed for ${message.senderUsername}: ${String(err)}`,
              );
            }
          }
        }
        runtime.log?.(`keybase: drop DM from ${message.senderUsername} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = allowlistMatch(
    message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
    message.senderUsername,
  );
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });

  if (message.isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: message.senderUsername,
    });
    return;
  }

  // Resolve team channel config for requireMention (only applies to actual team channels).
  const teamKey = message.isTeamChannel ? message.target.replace(/^team:/, "") : null;
  const teams = account.config.teams ?? {};
  const teamConfig = teamKey ? (teams[teamKey] ?? teams["*"] ?? null) : null;
  // Group chats (non-team) don't require a mention — respond to all messages from allowed senders.
  const requireMention = message.isTeamChannel ? (teamConfig?.requireMention ?? true) : false;

  if (message.isGroup && requireMention && !commandGate.commandAuthorized) {
    const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
    const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes);
    if (!wasMentioned) {
      runtime.log?.(`keybase: drop group ${message.target} (no mention)`);
      return;
    }
  }

  const peerId = message.isGroup ? message.target : message.senderUsername;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = message.isGroup ? message.target : message.senderUsername;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // For attachment-only messages, use a placeholder based on MIME type.
  const firstAttachmentMime = message.attachments?.[0]?.mimeType ?? "";
  const mediaPlaceholder =
    firstAttachmentMime.startsWith("audio/") || firstAttachmentMime.startsWith("video/")
      ? "<media:audio>"
      : "<media:image>";
  const effectiveBodyText = rawBody || (hasAttachments ? mediaPlaceholder : "");

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Keybase",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: effectiveBodyText,
  });

  const groupSystemPrompt = teamConfig?.systemPrompt?.trim() || undefined;

  // Build media payload from downloaded attachments.
  const attachments = message.attachments ?? [];
  const mediaPaths = attachments.map((a) => a.localPath);
  const mediaTypes = attachments.map((a) => a.mimeType);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody || effectiveBodyText,
    CommandBody: rawBody,
    From: message.isGroup ? `keybase:team:${message.target}` : `keybase:${message.senderUsername}`,
    To: `keybase:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderUsername || undefined,
    SenderId: message.senderUsername,
    GroupSubject: message.isGroup ? message.target : undefined,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `keybase:${peerId}`,
    CommandAuthorized: commandGate.commandAuthorized,
    // Media attachments.
    ...(mediaPaths.length > 0 && {
      MediaPath: mediaPaths[0],
      MediaUrl: mediaPaths[0],
      MediaPaths: mediaPaths,
      MediaUrls: mediaPaths,
      MediaType: mediaTypes[0],
      MediaTypes: mediaTypes,
    }),
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`keybase: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverKeybaseReply({
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          target: peerId,
          accountId: account.accountId,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`keybase ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      skillFilter: teamConfig?.systemPrompt ? undefined : undefined,
      onModelSelected,
    },
  });
}
