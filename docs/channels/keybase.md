---
summary: "Keybase encrypted messaging channel setup, access controls, and configuration"
read_when:
  - Working on Keybase channel features
  - You want to connect OpenClaw to Keybase DMs or team channels
title: "Keybase"
---

# Keybase (plugin)

Keybase is an end-to-end encrypted messaging platform with support for direct messages and team channels.
OpenClaw connects as a Keybase **bot user** via paper key authentication, so you need a dedicated
Keybase account for the bot. Once configured, users can DM the bot directly or mention it in team channels.

**Status:** Supported via plugin (`@vrtx-labs/keybase-bot`). Direct messages, team channels,
mention gating, pairing, allowlists. No native media support (media falls back to text + URL).

## Plugin required

Keybase ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/keybase
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/keybase
```

If you choose Keybase during configure/onboarding and a git checkout is detected,
OpenClaw will offer the local install path automatically.

Details: [Plugins](/tools/plugin)

## Prerequisites

1. **Keybase account** - create one at [https://keybase.io](https://keybase.io) for your bot.
2. **Paper key** - generate from Settings > Devices > Add a device > Paper key.
   This is a multi-word passphrase that lets the bot log in without interactive device provisioning.
3. **Keybase binary** - install from [https://keybase.io/download](https://keybase.io/download)
   and ensure it is on your `PATH`. The bot library spawns the `keybase` CLI under the hood.

## Setup

1. Install the Keybase plugin (see above).
2. Create a Keybase account and paper key.
3. Install the `keybase` binary on the machine running the gateway.
4. Configure credentials (pick one):
   - **Environment variables**: `KEYBASE_USERNAME`, `KEYBASE_PAPERKEY` (and optionally `KEYBASE_BINARY`).
   - **Config file**: set `channels.keybase.username`, `channels.keybase.paperkey` (or `channels.keybase.paperkeyFile`).
   - **CLI**: `openclaw channels add --channel keybase --username <user> --paperkey "<key>"`.
5. Enable the plugin: `openclaw plugins enable keybase`.
6. Restart the gateway.
7. Verify: `openclaw channels status --probe`.

Minimal config (paper key inline):

```json5
{
  channels: {
    keybase: {
      enabled: true,
      username: "mybot",
      paperkey: "word1 word2 word3 word4 word5 word6 word7 word8",
      dm: { policy: "pairing" },
    },
  },
}
```

Minimal config (paper key in file - recommended for production):

```json5
{
  channels: {
    keybase: {
      enabled: true,
      username: "mybot",
      paperkeyFile: "/run/secrets/keybase-paperkey",
    },
  },
}
```

## Access control (DMs)

DM access is controlled by `channels.keybase.dmPolicy`:

| Policy | Behavior |
|--------|----------|
| `"pairing"` (default) | Unknown senders get a pairing code; approve via `openclaw pairing approve`. |
| `"allowlist"` | Only usernames in `channels.keybase.allowFrom` can DM. No pairing flow. |
| `"open"` | Anyone can DM. Requires `allowFrom` to include `"*"` as a safety confirmation. |
| `"disabled"` | DMs are silently dropped. |

Allowlist example:

```json5
{
  channels: {
    keybase: {
      dmPolicy: "allowlist",
      allowFrom: ["alice", "bob"],
    },
  },
}
```

## Team channels (groups)

Keybase teams are treated as groups. The bot joins via its account credentials and listens
for messages in team channels.

Group access is controlled by `channels.keybase.groupPolicy`:

| Policy | Behavior |
|--------|----------|
| `"allowlist"` (default) | Only teams listed in `channels.keybase.teams` are monitored. |
| `"open"` | All team channels the bot can see are monitored (mention-gated by default). |
| `"disabled"` | Team channel messages are silently dropped. |

Configure specific teams:

```json5
{
  channels: {
    keybase: {
      groupPolicy: "allowlist",
      teams: {
        "myteam#general": { requireMention: true },
        "myteam#random": { requireMention: false },
        "otherteam#dev": {
          enabled: true,
          allowFrom: ["alice"],
          systemPrompt: "You are a dev assistant.",
        },
      },
    },
  },
}
```

Per-team options:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `requireMention` | boolean | `true` | Bot only responds when mentioned by name. |
| `enabled` | boolean | `true` | Enable/disable this team channel. |
| `allowFrom` | string[] | - | Restrict which team members can trigger the bot. |
| `systemPrompt` | string | - | Override system prompt for this team channel. |

A wildcard entry `"*"` applies defaults to all teams not explicitly listed.

## Mention gating

In team channels with `requireMention: true` (the default), the bot only responds when
its name appears in the message. Configure mention patterns via the global
`mentions` config or `botName` setting. See [Group messages](/channels/group-messages).

## Multi-account

Like other channels, Keybase supports multiple accounts:

```json5
{
  channels: {
    keybase: {
      accounts: {
        work: {
          username: "workbot",
          paperkeyFile: "/run/secrets/keybase-work",
          dmPolicy: "allowlist",
          allowFrom: ["colleague1"],
        },
        personal: {
          username: "personalbot",
          paperkeyFile: "/run/secrets/keybase-personal",
          dmPolicy: "pairing",
        },
      },
    },
  },
}
```

Top-level `channels.keybase.*` fields serve as defaults; per-account fields override them.

## Capabilities

| Feature | Supported |
|---------|-----------|
| Direct messages | Yes |
| Team channels (groups) | Yes |
| Media (images, files) | No (falls back to text + URL) |
| Reactions | No |
| Threads | No |
| Pairing flow | Yes |
| Allowlists | Yes |
| Mention gating | Yes |
| Multi-account | Yes |

## Environment variables

| Variable | Description |
|----------|-------------|
| `KEYBASE_USERNAME` | Bot username (default account only). |
| `KEYBASE_PAPERKEY` | Paper key for login (default account only). |
| `KEYBASE_BINARY` | Path to `keybase` binary if not on `PATH` (default account only). |

Environment variables are only used for the default account. Multi-account setups
must use config fields or `paperkeyFile`.

## Target format

Keybase targets used in routing, `openclaw message send`, and allowlists:

| Type | Format | Example |
|------|--------|---------|
| DM | `<username>` or `user:<username>` | `alice` |
| Team channel | `<team>#<channel>` or `team:<team>#<channel>` | `myteam#general` |

## Configuration reference

All keys live under `channels.keybase` (or `channels.keybase.accounts.<id>` for multi-account).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the channel. |
| `username` | string | - | Keybase bot username. |
| `paperkey` | string | - | Paper key (prefer `paperkeyFile`). |
| `paperkeyFile` | string | - | Path to file containing the paper key. |
| `keybasePath` | string | - | Path to `keybase` binary (if not on `PATH`). |
| `dmPolicy` | string | `"pairing"` | `"pairing"`, `"allowlist"`, `"open"`, or `"disabled"`. |
| `allowFrom` | string[] | - | Usernames allowed to DM. |
| `groupPolicy` | string | `"allowlist"` | `"allowlist"`, `"open"`, or `"disabled"`. |
| `groupAllowFrom` | string[] | - | Restrict which users can trigger the bot in teams. |
| `teams` | object | - | Per-team channel config (see Team channels above). |
| `accounts` | object | - | Multi-account config map. |
| `historyLimit` | number | - | Max history messages loaded per session. |
| `dmHistoryLimit` | number | - | Max DM history messages (overrides `historyLimit` for DMs). |
| `mediaMaxMb` | number | - | Max media size in MB (not currently used - media unsupported). |

See also: [Configuration](/gateway/configuration), [Security](/gateway/security).

## Troubleshooting

Standard diagnostic ladder:

```bash
openclaw status
openclaw channels status --probe
openclaw channels status --deep
```

Common issues:

- **"keybase: command not found"** - the `keybase` binary is not on `PATH`. Install it or set `channels.keybase.keybasePath`.
- **"need username and paperkey"** - both `username` and a paper key source (env, file, or config) are required.
- **Bot not responding in teams** - check `groupPolicy` and `teams` config. With `groupPolicy: "allowlist"`, the team must be listed in `teams`.
- **Bot not responding to DMs** - check `dmPolicy` and `allowFrom`. With `dmPolicy: "pairing"`, the sender must complete pairing first.
- **Paper key rejected** - paper keys are multi-word phrases generated by Keybase. Ensure the full key is provided without extra whitespace. Regenerate if unsure.

General troubleshooting: [Channel troubleshooting](/channels/troubleshooting).

## Security notes

- Store paper keys in files (`paperkeyFile`) or environment variables rather than inline config.
- The bot uses Keybase "oneshot" login via the paper key - it does not persist device state.
- DM policy defaults to `"pairing"` for safety; switch to `"open"` only after setting `allowFrom: ["*"]`.
- Team channel policy defaults to `"allowlist"` with mention gating enabled.
