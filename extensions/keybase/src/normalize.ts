/**
 * Keybase target formats:
 *   DM:    "alice"  or  "user:alice"
 *   Team:  "myteam#general"  or  "team:myteam#general"
 *
 * Canonical outbound targets sent to bot.chat.send():
 *   DM:    ChatChannel { name: "alice", membersType: "impteamnative" }
 *   Team:  ChatChannel { name: "myteam", membersType: "team", topicName: "general" }
 */

/** Returns true when the string looks like a Keybase team channel target. */
export function isKeybaseTeamTarget(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("team:")) {
    return true;
  }
  // "name#channel" with no spaces is a team channel.
  const stripped = trimmed.replace(/^keybase:/i, "");
  return /^[a-z0-9_.-]+#[a-z0-9_-]+$/.test(stripped);
}

/**
 * Normalize a raw messaging target string to a canonical form:
 *   DM:   "alice"
 *   Team: "myteam#general"
 * Returns undefined for empty or invalid input.
 */
export function normalizeKeybaseTarget(raw: string): string | undefined {
  let normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }

  // Strip scheme prefix.
  if (/^keybase:/i.test(normalized)) {
    normalized = normalized.slice("keybase:".length).trim();
  }

  // Strip explicit "user:" prefix for DMs.
  if (/^user:/i.test(normalized)) {
    normalized = normalized.slice("user:".length).trim();
  }

  // Strip explicit "team:" prefix but keep the #channel suffix.
  if (/^team:/i.test(normalized)) {
    normalized = normalized.slice("team:".length).trim();
  }

  if (!normalized) {
    return undefined;
  }

  // Validate: Keybase usernames are lowercase alphanumeric + underscore.
  // Team names can also contain dots and dashes. Topic names: alphanumeric + dashes.
  const teamPattern = /^[a-z0-9_][a-z0-9_.]{0,62}#[a-z0-9_-]+$/;
  const userPattern = /^[a-z0-9_][a-z0-9_]{0,14}$/;

  const lower = normalized.toLowerCase();
  if (teamPattern.test(lower) || userPattern.test(lower)) {
    return lower;
  }

  return undefined;
}

/** Returns true when the raw string looks like a Keybase user or team target. */
export function looksLikeKeybaseTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(keybase:|user:|team:)/i.test(trimmed)) {
    return true;
  }
  // "name#channel" pattern is unambiguously a Keybase team channel.
  if (trimmed.includes("#")) {
    return true;
  }
  return false;
}

/** Normalize an allowFrom entry for config storage (lowercase, strip scheme). */
export function normalizeKeybaseAllowEntry(raw: string): string {
  return (normalizeKeybaseTarget(raw) ?? raw.trim()).toLowerCase();
}
