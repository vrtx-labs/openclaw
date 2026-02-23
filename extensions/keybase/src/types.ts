import type { BaseProbeResult, DmPolicy, GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk";

export type KeybaseTeamChannelConfig = {
  requireMention?: boolean;
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type KeybaseAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** Keybase username for the bot account. */
  username?: string;
  /** Paper key for oneshot login. Prefer paperkeyFile for security. */
  paperkey?: string;
  /** Path to a file containing the paper key. */
  paperkeyFile?: string;
  /** Optional path to the keybase binary if not on PATH. */
  keybasePath?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  /** Keybase team channels to listen in: { "myteam#general": {} } */
  teams?: Record<string, KeybaseTeamChannelConfig>;
  historyLimit?: number;
  dmHistoryLimit?: number;
  mediaMaxMb?: number;
};

export type KeybaseConfig = KeybaseAccountConfig & {
  accounts?: Record<string, KeybaseAccountConfig>;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    keybase?: KeybaseConfig;
  };
};

export type ResolvedKeybaseAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  username: string;
  paperkey: string;
  paperkeySource: "env" | "paperkeyFile" | "config" | "none";
  keybasePath?: string;
  config: KeybaseAccountConfig;
};

/** Inbound message from Keybase chat listener. */
export type KeybaseInboundMessage = {
  messageId: string;
  /** Conversation target: "user:alice" for DMs, "team:myteam#general" for team channels. */
  target: string;
  senderUsername: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  /** Raw Keybase channel object for replies. */
  rawChannel: {
    name: string;
    membersType?: string;
    topicName?: string;
  };
};

export type KeybaseProbe = BaseProbeResult<string> & {
  username?: string;
  version?: string;
  latencyMs?: number;
};
