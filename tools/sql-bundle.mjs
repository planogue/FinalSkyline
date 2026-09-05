/**
 * Concatenates migrations into one file to paste into the Supabase SQL editor,
 * for a project being administered by hand rather than through the CLI.
 *
 *   node tools/sql-bundle.mjs                 # every migration, for a new project
 *   node tools/sql-bundle.mjs --from 2026090  # only those at or after that name
 *
 * Writes supabase/run-in-supabase.sql. The file is generated and git-ignored:
 * the migrations stay the single source of truth.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '..', 'supabase', 'migrations');
const OUT = path.join(HERE, '..', 'supabase', 'run-in-supabase.sql');

const fromIndex = process.argv.indexOf('--from');
const from = fromIndex >= 0 ? process.argv[fromIndex + 1] : null;

const all = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
const chosen = from ? all.filter((name) => name >= from) : all;
const skipped = all.filter((name) => !chosen.includes(name));

if (!chosen.length) {
  console.error(`No migrations at or after "${from}".`);
  process.exit(1);
}

const rule = '-- ' + '='.repeat(73);
const lines = [
  rule.replace('-- ', '-- ===='),
  '-- Final Skyline — database changes to apply',
  '--',
  '-- Paste the whole file into the Supabase SQL editor and run it once.',
];

if (skipped.length) {
  lines.push(
    '--',
    '-- It assumes these are already applied, which they are if online',
    '-- matchmaking currently works:',
    ...skipped.map((name) => `--     ${name}`),
  );
}

lines.push(
  '--',
  '-- One setting this cannot do for you, in Authentication -> Sign In / Providers:',
  '--   * "Confirm email" off, so creating an account signs the player straight in',
  '--   * "Anonymous sign-ins" on, only if you want the Play as guest button to work',
  rule.replace('-- ', '-- ===='),
  '',
);

for (const name of chosen) {
  lines.push(rule, `-- ${name}`, rule, '');
  lines.push(readFileSync(path.join(MIGRATIONS, name), 'utf8').trimEnd(), '');
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
for (const name of chosen) console.log(`  included ${name}`);
for (const name of skipped) console.log(`  assumed already applied: ${name}`);
