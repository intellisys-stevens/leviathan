import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Leviathan brand assets', () => {
  it('ships a readable SVG mark with an accessible title', () => {
    const source = readFileSync(resolve('public/leviathan-mark.svg'), 'utf8');
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml');
    const mark = svg.documentElement;
    expect(svg.querySelector('parsererror')).toBeNull();
    expect(mark.getAttribute('role')).toBe('img');
    const title = svg.getElementById(mark.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('Leviathan frost-dragon mark');
    expect(svg.querySelector('path')).not.toBeNull();
  });

  it('uses the mark and Leviathan metadata in the document shell', () => {
    const source = readFileSync(resolve('index.html'), 'utf8');
    const shell = new DOMParser().parseFromString(source, 'text/html');
    expect(shell.title).toBe('Leviathan · Host monitor');
    expect(shell.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(
      '/leviathan-mark.svg',
    );
  });
});
