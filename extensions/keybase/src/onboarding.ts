import {
  DEFAULT_ACCOUNT_ID,
  addWildcardAllowFrom,
  formatDocsLink,
  promptAccountId,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type DmPolicy,
  type WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  listKeybaseAccountIds,
  resolveDefaultKeybaseAccountId,
  resolveKeybaseAccount,
} from "./accounts.js";
import { normalizeKeybaseAllowEntry } from "./normalize.js";
import type { CoreConfig, KeybaseAccountConfig } from "./types.js";

const channel = "keybase" as const;

function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function updateKeybaseAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<KeybaseAccountConfig>,
): CoreConfig {
  const current = cfg.channels?.keybase ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        keybase: {
          ...current,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      keybase: {
        ...current,
        accounts: {
          ...current.accounts,
          [accountId]: {
            ...current.accounts?.[accountId],
            ...patch,
          },
        },
      },
    },
  };
}

function setKeybaseDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.keybase?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      keybase: {
        ...cfg.channels?.keybase,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setKeybaseAllowFrom(cfg: CoreConfig, allowFrom: string[]): CoreConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      keybase: {
        ...cfg.channels?.keybase,
        allowFrom,
      },
    },
  };
}

async function noteKeybaseSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Keybase needs a bot username and paper key.",
      "1. Create a Keybase account at https://keybase.io for your bot.",
      "2. Generate a paper key from Settings > Devices > Add a device > Paper key.",
      "3. Install the keybase binary (https://keybase.io/download) and ensure it is on PATH.",
      "Env vars supported: KEYBASE_USERNAME, KEYBASE_PAPERKEY, KEYBASE_BINARY.",
      `Docs: ${formatDocsLink("/channels/keybase", "channels/keybase")}`,
    ].join("\n"),
    "Keybase setup",
  );
}

async function promptKeybaseAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
}): Promise<CoreConfig> {
  const existing = params.cfg.channels?.keybase?.allowFrom ?? [];

  await params.prompter.note(
    [
      "Allowlist Keybase DMs by sender username.",
      "Examples:",
      "- alice",
      "- bob",
      "Multiple entries: comma-separated.",
    ].join("\n"),
    "Keybase allowlist",
  );

  const raw = await params.prompter.text({
    message: "Keybase allowFrom (username)",
    placeholder: "alice, bob",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const parsed = parseListInput(String(raw));
  const normalized = [
    ...new Set(
      parsed
        .map((entry) => normalizeKeybaseAllowEntry(entry))
        .filter(Boolean),
    ),
  ];
  return setKeybaseAllowFrom(params.cfg, normalized);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Keybase",
  channel,
  policyKey: "channels.keybase.dmPolicy",
  allowFromKey: "channels.keybase.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.keybase?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setKeybaseDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: (params) =>
    promptKeybaseAllowFrom({ cfg: params.cfg as CoreConfig, prompter: params.prompter }),
};

export const keybaseOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const coreCfg = cfg as CoreConfig;
    const configured = listKeybaseAccountIds(coreCfg).some(
      (accountId) => resolveKeybaseAccount({ cfg: coreCfg, accountId }).configured,
    );
    return {
      channel,
      configured,
      statusLines: [`Keybase: ${configured ? "configured" : "needs username + paper key"}`],
      selectionHint: configured ? "configured" : "needs username + paper key",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    let next = cfg as CoreConfig;
    const keybaseOverride = accountOverrides.keybase?.trim();
    const defaultAccountId = resolveDefaultKeybaseAccountId(next);
    let accountId = keybaseOverride || defaultAccountId;

    if (shouldPromptAccountIds && !keybaseOverride) {
      accountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "Keybase",
        currentId: accountId,
        listAccountIds: listKeybaseAccountIds,
        defaultAccountId,
      });
    }

    const resolved = resolveKeybaseAccount({ cfg: next, accountId });
    const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
    const envUsername = isDefaultAccount ? process.env.KEYBASE_USERNAME?.trim() : "";
    const envPaperkey = isDefaultAccount ? process.env.KEYBASE_PAPERKEY?.trim() : "";
    const envReady = Boolean(envUsername && envPaperkey);

    if (!resolved.configured) {
      await noteKeybaseSetupHelp(prompter);
    }

    let useEnv = false;
    if (envReady && isDefaultAccount && !resolved.config.username && !resolved.config.paperkey) {
      useEnv = await prompter.confirm({
        message: "KEYBASE_USERNAME and KEYBASE_PAPERKEY detected. Use env vars?",
        initialValue: true,
      });
    }

    if (useEnv) {
      next = updateKeybaseAccountConfig(next, accountId, { enabled: true });
    } else {
      const username = String(
        await prompter.text({
          message: "Keybase bot username",
          initialValue: resolved.config.username || envUsername || undefined,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const paperkey = String(
        await prompter.text({
          message: "Keybase paper key",
          initialValue: resolved.config.paperkey || undefined,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      next = updateKeybaseAccountConfig(next, accountId, {
        enabled: true,
        username,
        paperkey,
      });
    }

    if (forceAllowFrom) {
      next = await promptKeybaseAllowFrom({ cfg: next, prompter });
    }

    await prompter.note(
      [
        "Next: restart gateway and verify status.",
        "Command: openclaw channels status --probe",
        `Docs: ${formatDocsLink("/channels/keybase", "channels/keybase")}`,
      ].join("\n"),
      "Keybase next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      keybase: {
        ...(cfg as CoreConfig).channels?.keybase,
        enabled: false,
      },
    },
  }),
};
