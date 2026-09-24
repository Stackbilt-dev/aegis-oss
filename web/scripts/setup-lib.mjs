// Pure helpers for scripts/setup.mjs. No I/O here, so they can be unit-tested.

import { randomBytes } from 'node:crypto';

/** Worker and D1 names: lowercase letters, digits, and dashes; 1–63 chars; no leading or trailing dash. */
export function workerNameError(name) {
  if (typeof name !== 'string' || !name) return 'a name is required';
  if (name.length > 63) return 'names are at most 63 characters';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return 'use lowercase letters, digits, and dashes, starting and ending with a letter or digit';
  }
  return null;
}

/**
 * wrangler.toml from wrangler.toml.example: sets the Worker name, the D1
 * database name and id, and optionally the account id. Throws if the example's
 * placeholders have moved, rather than writing a config that silently lacks them.
 */
export function renderWranglerToml(example, { name, databaseName, databaseId, accountId }) {
  const replace = (text, pattern, replacement, what) => {
    if (!pattern.test(text)) throw new Error(`wrangler.toml.example has no ${what} line to fill in`);
    return text.replace(pattern, replacement);
  };
  let toml = example;
  toml = replace(toml, /^name = ".*"$/m, `name = "${name}"`, 'name');
  toml = replace(toml, /^database_name = ".*"$/m, `database_name = "${databaseName}"`, 'database_name');
  toml = replace(toml, /^#?\s*database_id = ".*"$/m, `database_id = "${databaseId}"`, 'database_id');
  if (accountId) toml = replace(toml, /^#?\s*account_id = ".*"$/m, `account_id = "${accountId}"`, 'account_id');
  return toml;
}

/** The uuid of the D1 database named `name` in `wrangler d1 list --json` output, or null. */
export function findDatabaseId(listJson, name) {
  let rows;
  try {
    rows = JSON.parse(listJson);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => entry && entry.name === name);
  return row && typeof row.uuid === 'string' ? row.uuid : null;
}

/** The deployed URL from `wrangler deploy` output, or null. */
export function workerUrlFromDeployOutput(output) {
  const match = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(output ?? '');
  return match ? match[0] : null;
}

/** A 256-bit bearer token for AEGIS_TOKEN. */
export function generateToken() {
  return randomBytes(32).toString('hex');
}
