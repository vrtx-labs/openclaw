import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, KeybaseAccountConfig, ResolvedKeybaseAccount } from "./types.js";

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.keybase?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (key.trim()) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): KeybaseAccountConfig | undefined {
  const accounts = cfg.channels?.keybase?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as KeybaseAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as KeybaseAccountConfig | undefined) : undefined;
}

function mergeKeybaseAccountConfig(cfg: CoreConfig, accountId: string): KeybaseAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.keybase ?? {}) as KeybaseAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolvePaperkey(
  accountId: string,
  merged: KeybaseAccountConfig,
): { paperkey: string; source: ResolvedKeybaseAccount["paperkeySource"] } {
  // Environment variable only supported for default account.
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envPaperkey = process.env.KEYBASE_PAPERKEY?.trim();
    if (envPaperkey) {
      return { paperkey: envPaperkey, source: "env" };
    }
  }

  if (merged.paperkeyFile?.trim()) {
    try {
      const fileKey = readFileSync(merged.paperkeyFile.trim(), "utf-8").trim();
      if (fileKey) {
        return { paperkey: fileKey, source: "paperkeyFile" };
      }
    } catch {
      // Unreadable file; surface missing config via status/probe.
    }
  }

  const configKey = merged.paperkey?.trim();
  if (configKey) {
    return { paperkey: configKey, source: "config" };
  }

  return { paperkey: "", source: "none" };
}

export function listKeybaseAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultKeybaseAccountId(cfg: CoreConfig): string {
  const ids = listKeybaseAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveKeybaseAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedKeybaseAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.keybase?.enabled !== false;

  const resolve = (accountId: string): ResolvedKeybaseAccount => {
    const merged = mergeKeybaseAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;

    const username = (
      merged.username?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.KEYBASE_USERNAME?.trim() : "") ||
      ""
    ).trim();

    const { paperkey, source: paperkeySource } = resolvePaperkey(accountId, merged);

    const keybasePath =
      merged.keybasePath?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.KEYBASE_BINARY?.trim() : undefined) ||
      undefined;

    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      configured: Boolean(username && paperkey),
      username,
      paperkey,
      paperkeySource,
      keybasePath,
      config: merged,
    };
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.configured) {
    return primary;
  }

  const fallbackId = resolveDefaultKeybaseAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}

export function listEnabledKeybaseAccounts(cfg: CoreConfig): ResolvedKeybaseAccount[] {
  return listKeybaseAccountIds(cfg)
    .map((accountId) => resolveKeybaseAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
