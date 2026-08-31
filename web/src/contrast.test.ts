import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');
const lowContrastLightStatus =
  /(?<!dark:)text-(?:amber|orange|sky)-(?:50|100|200|300|400|500|600)\b/gu;

function componentSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return componentSources(path);
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) {
      return [];
    }
    return [path];
  });
}

describe('semantic status contrast', () => {
  it('uses AA-safe light-theme amber, orange, and sky text shades', () => {
    const offenders = componentSources(sourceRoot).flatMap((path) => {
      const matches = readFileSync(path, 'utf8').match(lowContrastLightStatus);
      return (
        matches?.map((token) => `${relative(sourceRoot, path)}: ${token}`) ?? []
      );
    });

    expect(offenders).toEqual([]);
  });
});
