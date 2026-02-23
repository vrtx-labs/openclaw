import {
  DmPolicySchema,
  GroupPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const KeybaseTeamChannelSchema = z
  .object({
    requireMention: z.boolean().optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const KeybaseAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    username: z.string().optional(),
    paperkey: z.string().optional(),
    paperkeyFile: z.string().optional(),
    keybasePath: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    teams: z.record(z.string(), KeybaseTeamChannelSchema.optional()).optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    mediaMaxMb: z.number().positive().optional(),
  })
  .strict();

export const KeybaseAccountSchema = KeybaseAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.keybase.dmPolicy="open" requires channels.keybase.allowFrom to include "*"',
  });
});

export const KeybaseConfigSchema = KeybaseAccountSchemaBase.extend({
  accounts: z.record(z.string(), KeybaseAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.keybase.dmPolicy="open" requires channels.keybase.allowFrom to include "*"',
  });
});
