import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const destinationArgument = process.argv[2];
if (!destinationArgument) {
  throw new Error('usage: node scripts/save-licenses.mjs <destination>');
}

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const destination = path.resolve(process.cwd(), destinationArgument);
const lock = JSON.parse(
  await readFile(path.join(webRoot, 'package-lock.json'), 'utf8'),
);
const noticeRows = [];
const copied = new Set();

await mkdir(destination, { recursive: true });

for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (packagePath === '' || metadata.dev || !metadata.version) continue;

  const packageDirectory = path.join(webRoot, packagePath);
  let packageJSON;
  try {
    packageJSON = JSON.parse(
      await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
    );
  } catch (error) {
    if (error?.code === 'ENOENT' && metadata.optional) continue;
    throw error;
  }
  const name = packageJSON.name;
  const identity = `${name}@${metadata.version}`;
  if (copied.has(identity)) continue;
  copied.add(identity);

  const files = await readdir(packageDirectory);
  let notices = files.filter((file) =>
    /^(licen[cs]e|copying|notice)(\..*)?$/i.test(file),
  );
  if (notices.length === 0 && files.includes('README.md')) {
    notices = ['README.md'];
  }
  if (notices.length === 0) {
    throw new Error(`${identity} has no distributable license or notice file`);
  }

  const packageDestination = path.join(
    destination,
    identity.replaceAll(/[^a-zA-Z0-9._-]/g, '_'),
  );
  await mkdir(packageDestination, { recursive: true });
  for (const file of notices.sort((left, right) => left.localeCompare(right))) {
    await copyFile(
      path.join(packageDirectory, file),
      path.join(packageDestination, file),
    );
  }
  noticeRows.push(`${identity} — ${metadata.license}`);
}

noticeRows.sort((left, right) => left.localeCompare(right));
await writeFile(
  path.join(destination, 'THIRD_PARTY_NOTICES.txt'),
  `MIGLens embedded web production dependencies\n\n${noticeRows.join('\n')}\n`,
);
console.log(
  `Saved notices for ${noticeRows.length} production web packages to ${destination}.`,
);
