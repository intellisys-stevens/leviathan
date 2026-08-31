import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDirectory = resolve(process.cwd(), 'public');
const markPath = resolve(publicDirectory, 'leviathan-mark.svg');
const indexPath = resolve(process.cwd(), 'index.html');

describe('Leviathan brand assets', () => {
  it('ships one compact, script-free world-serpent mark', () => {
    const mark = readFileSync(markPath, 'utf8');
    const imageAssets = readdirSync(publicDirectory).filter((name) =>
      /\.(?:png|svg)$/u.test(name),
    );

    expect(imageAssets).toEqual(['leviathan-mark.svg']);
    expect(statSync(markPath).size).toBeLessThan(8 * 1024);
    expect(mark).toContain('Leviathan world-serpent mark');
    expect(mark).toContain('<mask id="facets">');
    expect(mark).toContain('mask="url(#facets)"');
    expect(mark).not.toMatch(
      /<(?:script|foreignObject|iframe|object|embed)\b|\bon\w+\s*=|javascript:/iu,
    );
    expect(existsSync(`${publicDirectory}/miglens-mark.png`)).toBe(false);
    expect(existsSync(`${publicDirectory}/favicon.svg`)).toBe(false);
  });

  it('uses the mark and Leviathan metadata in the document shell', () => {
    const document = readFileSync(indexPath, 'utf8');

    expect(document).toContain('href="/leviathan-mark.svg"');
    expect(document).toContain('<title>Leviathan · GPU monitor</title>');
    expect(document).not.toContain('miglens-mark');
  });
});
