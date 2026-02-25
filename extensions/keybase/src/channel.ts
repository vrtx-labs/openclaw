import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  listKeybaseAccountIds,
  resolveDefaultKeybaseAccountId,
  resolveKeybaseAccount,
} from "./accounts.js";
import { KeybaseConfigSchema } from "./config-schema.js";
import { monitorKeybaseProvider } from "./monitor.js";
import {
  looksLikeKeybaseTargetId,
  normalizeKeybaseAllowEntry,
  normalizeKeybaseTarget,
} from "./normalize.js";
import { keybaseOnboardingAdapter } from "./onboarding.js";
import { probeKeybase } from "./probe.js";
import { attachFileKeybase, sendMessageKeybase } from "./send.js";
import type { ResolvedKeybaseAccount } from "./types.js";
import type { CoreConfig, KeybaseProbe } from "./types.js";

const meta = {
  id: "keybase",
  label: "Keybase",
  selectionLabel: "Keybase (plugin)",
  docsPath: "/channels/keybase",
  docsLabel: "keybase",
  blurb: "encrypted messaging; install the plugin and keybase binary to enable.",
  order: 80,
  quickstartAllowFrom: true,
};

export const keybasePlugin: ChannelPlugin<ResolvedKeybaseAccount, KeybaseProbe> = {
  id: "keybase",
  meta,
  onboarding: keybaseOnboardingAdapter,
  pairing: {
    idLabel: "keybaseUsername",
    normalizeAllowEntry: (entry) => normalizeKeybaseAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      const target = normalizeKeybaseTarget(id);
      if (!target) {
        throw new Error(`Invalid Keybase pairing id: ${id}`);
      }
      await sendMessageKeybase(target, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.keybase"] },
  configSchema: buildChannelConfigSchema(KeybaseConfigSchema),
  config: {
    listAccountIds: (cfg) => listKeybaseAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveKeybaseAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultKeybaseAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "keybase",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "keybase",
        accountId,
        clearBaseFields: ["name", "username", "paperkey", "paperkeyFile", "keybasePath"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      username: account.username || undefined,
      paperkeySource: account.paperkeySource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveKeybaseAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => normalizeKeybaseAllowEntry(String(entry))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg as CoreConfig).channels?.keybase?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.keybase.accounts.${resolvedAccountId}.`
        : "channels.keybase.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("keybase"),
        normalizeEntry: (raw) => normalizeKeybaseAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: (cfg as CoreConfig).channels?.keybase !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy === "open") {
        warnings.push(
          '- Keybase teams: groupPolicy="open" allows all team channels (mention-gated). Prefer channels.keybase.groupPolicy="allowlist" with channels.keybase.teams.',
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      if (!groupId) {
        return true;
      }
      const account = resolveKeybaseAccount({ cfg: cfg as CoreConfig, accountId });
      const teamKey = groupId.replace(/^team:/, "");
      const teams = account.config.teams ?? {};
      const teamConfig = teams[teamKey] ?? teams["*"] ?? null;
      return teamConfig?.requireMention ?? true;
    },
    resolveToolPolicy: () => undefined,
  },
  messaging: {
    normalizeTarget: normalizeKeybaseTarget,
    targetResolver: {
      looksLikeId: looksLikeKeybaseTargetId,
      hint: "<username|team#channel>",
    },
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      return inputs.map((input) => {
        const normalized = normalizeKeybaseTarget(input);
        if (!normalized) {
          return { input, resolved: false, note: "invalid Keybase target" };
        }
        const isTeam = normalized.includes("#");
        if (kind === "group") {
          if (!isTeam) {
            return { input, resolved: false, note: "expected team#channel target" };
          }
          return { input, resolved: true, id: `team:${normalized}`, name: normalized };
        }
        if (isTeam) {
          return { input, resolved: false, note: "expected user target" };
        }
        return { input, resolved: true, id: normalized, name: normalized };
      });
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveKeybaseAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() ?? "";
      const ids = new Set<string>();

      for (const entry of account.config.allowFrom ?? []) {
        const normalized = normalizeKeybaseAllowEntry(String(entry));
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }
      for (const entry of account.config.groupAllowFrom ?? []) {
        const normalized = normalizeKeybaseAllowEntry(String(entry));
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }

      return Array.from(ids)
        .filter((id) => (q ? id.includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user" as const, id }));
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveKeybaseAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() ?? "";
      const teams = account.config.teams ?? {};

      return Object.keys(teams)
        .filter((key) => key !== "*")
        .map((key) => `team:${key}`)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group" as const, id, name: id }));
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to, text, accountId }) => {
      const result = await sendMessageKeybase(to, text, {
        accountId: accountId ?? undefined,
      });
      return { channel: "keybase", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      // If mediaUrl looks like a local file path, send it as an attachment.
      if (mediaUrl && (mediaUrl.startsWith("/") || mediaUrl.startsWith("./"))) {
        if (text?.trim()) {
          await sendMessageKeybase(to, text.trim(), { accountId: accountId ?? undefined });
        }
        const result = await attachFileKeybase(to, mediaUrl, {
          accountId: accountId ?? undefined,
          title: text?.trim() || undefined,
        });
        return { channel: "keybase", ...result };
      }
      const combined = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendMessageKeybase(to, combined, {
        accountId: accountId ?? undefined,
      });
      return { channel: "keybase", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "keybase",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg, account, timeoutMs }) =>
      probeKeybase(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      username: account.username || null,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "keybase",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (input.useEnv) {
        return null;
      }
      if (!input.username?.trim()) {
        return "Keybase requires --username";
      }
      if (!input.paperkey?.trim() && !input.paperkeyFile?.trim()) {
        return "Keybase requires --paperkey or --paperkey-file";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const coreCfg = cfg as CoreConfig;
      const existing = coreCfg.channels?.keybase ?? {};
      if (input.useEnv) {
        return {
          ...coreCfg,
          channels: { ...coreCfg.channels, keybase: { ...existing, enabled: true } },
        } as CoreConfig;
      }
      return {
        ...coreCfg,
        channels: {
          ...coreCfg.channels,
          keybase: {
            ...existing,
            enabled: true,
            ...(input.username?.trim() ? { username: input.username.trim() } : {}),
            ...(input.paperkey?.trim() ? { paperkey: input.paperkey.trim() } : {}),
            ...(input.paperkeyFile?.trim() ? { paperkeyFile: input.paperkeyFile.trim() } : {}),
          },
        },
      } as CoreConfig;
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `Keybase is not configured for account "${account.accountId}" (need username and paperkey in channels.keybase).`,
        );
      }
      ctx.log?.info(`[${account.accountId}] starting Keybase provider (${account.username})`);
      const { stop } = await monitorKeybaseProvider({
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      return { stop };
    },
  },
};
