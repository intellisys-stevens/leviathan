import { readFile } from 'node:fs/promises';

const lock = JSON.parse(
  await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
);
const denied =
  /(?:^|[^A-Z])(AGPL|GPL|LGPL|SSPL|BUSL|UNLICENSED|UNKNOWN)(?:$|[^A-Z])/i;
const missing = [];
const rejected = [];
const licenses = new Set();
let checked = 0;

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (path === '') continue;
  checked += 1;
  if (typeof metadata.license !== 'string' || metadata.license.trim() === '') {
    missing.push(path);
    continue;
  }
  licenses.add(metadata.license);
  if (denied.test(metadata.license))
    rejected.push(`${path}: ${metadata.license}`);
}

if (missing.length > 0 || rejected.length > 0) {
  if (missing.length > 0)
    console.error(`Missing license metadata:\n${missing.join('\n')}`);
  if (rejected.length > 0)
    console.error(`Disallowed licenses:\n${rejected.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${checked} locked packages (${[...licenses].sort((left, right) => left.localeCompare(right)).join(', ')}).`,
  );
}
