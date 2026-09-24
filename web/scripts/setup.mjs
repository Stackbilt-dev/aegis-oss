#!/usr/bin/env node
// One-command setup for a fresh AEGIS deployment.
//
//   pnpm run setup                      # prompts for a name
//   pnpm run setup -- --name my-agent   # no prompt
//   pnpm run setup -- --dry-run         # print every command; change nothing
//
// Steps: check the wrangler login → create (or reuse) the D1 database → write
// wrangler.toml → apply schema.sql → deploy → set a generated AEGIS_TOKEN →
// check /health. Safe to re-run: it reuses an existing database of the same
// name, the schema is idempotent, and it refuses to overwrite an existing
// wrangler.toml unless you pass --force.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  findDatabaseId,
  generateToken,
  renderWranglerToml,
  workerNameError,
  workerUrlFromDeployOutput,
} from './setup-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const dryRun = flag('dry-run');
const force = flag('force');

const step = (message) => console.log(`\n▸ ${message}`);
const fail = (message) => {
  console.error(`\n✘ ${message}`);
  process.exit(1);
};

/** Runs a command in web/. In dry-run mode, prints it and returns `dryResult`. */
function run(command, commandArgs, { input, capture = true, dryResult = { status: 0, stdout: '' } } = {}) {
  const shown = `${command} ${commandArgs.join(' ')}`;
  if (dryRun) {
    console.log(`  [dry-run] ${shown}${input ? '  (secret from stdin)' : ''}`);
    return dryResult;
  }
  console.log(`  $ ${shown}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    input,
    encoding: 'utf8',
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (result.error) fail(`${shown} could not start: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function askName() {
  const given = option('name');
  if (given) return given;
  if (dryRun || !process.stdin.isTTY) return 'my-agent';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Name for your agent (Worker and database name) [my-agent]: ')).trim();
  rl.close();
  return answer || 'my-agent';
}

async function main() {
  console.log(`AEGIS setup${dryRun ? ' (dry run: nothing will be changed)' : ''}`);

  const tomlPath = join(root, 'wrangler.toml');
  if (existsSync(tomlPath) && !force && !dryRun) {
    fail('wrangler.toml already exists. This looks set up already. Re-run with --force to regenerate it.');
  }

  const name = await askName();
  const nameError = workerNameError(name);
  if (nameError) fail(`"${name}" is not a valid name: ${nameError}`);

  step('Checking your Cloudflare login');
  const whoami = run('npx', ['wrangler', 'whoami'], { dryResult: { status: 0, stdout: 'You are logged in' } });
  if (whoami.status !== 0 || /not authenticated/i.test(whoami.stdout)) {
    fail('Not logged in to Cloudflare. Run `npx wrangler login`, then run setup again.');
  }

  step(`Creating the D1 database "${name}" (reused if it already exists)`);
  const listDatabases = () => run('npx', ['wrangler', 'd1', 'list', '--json'], { dryResult: { status: 0, stdout: '[]' } });
  let databaseId = findDatabaseId(listDatabases().stdout, name);
  if (!databaseId) {
    const created = run('npx', ['wrangler', 'd1', 'create', name]);
    if (created.status !== 0) fail(`Could not create the database:\n${created.stdout}`);
    databaseId = dryRun ? '<new-database-id>' : findDatabaseId(listDatabases().stdout, name);
    if (!databaseId) fail('The database was created but its id could not be read from `wrangler d1 list --json`.');
  } else {
    console.log(`  Reusing ${databaseId}`);
  }

  step('Writing wrangler.toml');
  const toml = renderWranglerToml(readFileSync(join(root, 'wrangler.toml.example'), 'utf8'), {
    name,
    databaseName: name,
    databaseId,
  });
  if (dryRun) console.log(`  [dry-run] would write wrangler.toml (name = "${name}", database_id = "${databaseId}")`);
  else writeFileSync(tomlPath, toml);

  step('Applying the database schema');
  const schema = run('npx', ['wrangler', 'd1', 'execute', name, '--remote', '--file=schema.sql', '--yes'], { capture: false });
  if (schema.status !== 0) fail('Applying schema.sql failed (see the output above).');

  step('Building and deploying');
  const deploy = run('npm', ['run', 'deploy'], {
    dryResult: { status: 0, stdout: `https://${name}.example.workers.dev` },
  });
  if (deploy.status !== 0) fail(`Deploy failed:\n${deploy.stdout.slice(-3000)}`);
  const url = workerUrlFromDeployOutput(deploy.stdout);

  // After the deploy: setting a secret on a Worker that doesn't exist yet
  // creates a placeholder, and a first deploy can reset it.
  step('Setting AEGIS_TOKEN');
  const token = generateToken();
  const secret = run('npx', ['wrangler', 'secret', 'put', 'AEGIS_TOKEN'], { input: token });
  if (secret.status !== 0) fail(`Setting AEGIS_TOKEN failed:\n${secret.stdout}`);

  step('Checking /health');
  if (dryRun || !url) {
    console.log(dryRun ? '  [dry-run] would GET <url>/health' : '  Deploy output had no workers.dev URL; check `npx wrangler deployments list`.');
  } else {
    let healthy = false;
    for (let attempt = 0; attempt < 10 && !healthy; attempt++) {
      try {
        const response = await fetch(`${url}/health`, { headers: { Accept: 'application/json' } });
        healthy = response.ok;
      } catch {}
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    console.log(healthy ? `  ${url}/health is up` : `  ${url}/health did not respond yet; it can take a minute after a first deploy.`);

    // A new secret takes a few seconds to reach the Worker; confirm the token
    // actually signs in before telling the user to use it.
    step('Checking that the token signs in');
    let signedIn = false;
    for (let attempt = 0; attempt < 12 && !signedIn; attempt++) {
      try {
        const response = await fetch(`${url}/api/cc-tasks?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
        signedIn = response.ok;
      } catch {}
      if (!signedIn) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    console.log(signedIn ? '  Signed in with the new AEGIS_TOKEN' : '  The token was not accepted yet; wait a minute and try it.');
  }

  console.log(`
✔ AEGIS is ${dryRun ? 'ready to set up' : 'deployed'}.

  URL:          ${url ?? '(see the deploy output above)'}
  AEGIS_TOKEN:  ${dryRun ? '(generated at setup time)' : token}

Save the token now: it's how you sign in, and it isn't stored anywhere else.
Talk to your agent from a terminal:
  AEGIS_HOST=${url ? new URL(url).host : '<your-worker>.workers.dev'} AEGIS_TOKEN=<token> npx @stackbilt/aegis-core --quick

Optional next steps (docs/getting-started.md): set ANTHROPIC_API_KEY or GROQ_API_KEY
for stronger executors, and customise src/operator/config.ts.`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
