import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDirectory = resolve(process.cwd(), 'public');
const markPath = resolve(publicDirectory, 'leviathan-mark.svg');
const referencePath = resolve(
  process.cwd(),
  'e2e/fixtures/leviathan-mark-alpha.json',
);
const indexPath = resolve(process.cwd(), 'index.html');
const sourceSha256 =
  '1556d8fe7da4af39b968f84d56afe5d8531a152cba3338e268a8ece8a3ddbe4b';

type Point = readonly [number, number];

type AlphaReference = {
  width: number;
  height: number;
  threshold: number;
  sampling: string;
  encoding: string;
  sourceSha256: string;
  bbox: [number, number, number, number];
  components: number;
  alpha: string;
};

function svgPaths(source: string) {
  return [...source.matchAll(/<path\b[^>]*>/gu)].map(([tag]) => tag);
}

function attribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))?.[1];
}

function requiredPath(source: string, id: string) {
  const tag = svgPaths(source).find(
    (candidate) => attribute(candidate, 'id') === id,
  );
  if (!tag) throw new Error(`Expected the mark to contain path #${id}`);

  const data = attribute(tag, 'd');
  if (!data) throw new Error(`Expected path #${id} to contain geometry`);
  return { data, tag };
}

function flattenEvenOddPath(data: string): Point[][] {
  const tokens =
    data.match(/[MCLZ]|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/giu) ?? [];
  const contours: Point[][] = [];
  let index = 0;
  let command = '';
  let current: Point = [0, 0];
  let contour: Point[] | undefined;

  const number = () => {
    const token = tokens[index];
    if (token == null || /^[MCLZ]$/iu.test(token)) {
      throw new Error('Malformed traced path data');
    }
    index += 1;
    return Number(token);
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[MCLZ]$/iu.test(token)) {
      command = token.toUpperCase();
      index += 1;
      if (command === 'Z') {
        command = '';
        continue;
      }
    }

    if (command === 'M') {
      current = [number(), number()];
      contour = [current];
      contours.push(contour);
      command = 'L';
      continue;
    }
    if (!contour) throw new Error('Traced path must begin with M');
    if (command === 'L') {
      current = [number(), number()];
      contour.push(current);
      continue;
    }
    if (command === 'C') {
      const start = current;
      const controlA: Point = [number(), number()];
      const controlB: Point = [number(), number()];
      const end: Point = [number(), number()];
      for (let step = 1; step <= 32; step += 1) {
        const time = step / 32;
        const inverse = 1 - time;
        contour.push([
          inverse ** 3 * start[0] +
            3 * inverse ** 2 * time * controlA[0] +
            3 * inverse * time ** 2 * controlB[0] +
            time ** 3 * end[0],
          inverse ** 3 * start[1] +
            3 * inverse ** 2 * time * controlA[1] +
            3 * inverse * time ** 2 * controlB[1] +
            time ** 3 * end[1],
        ]);
      }
      current = end;
      continue;
    }
    throw new Error(`Unsupported traced path command: ${command}`);
  }

  return contours;
}

function rasterizeEvenOddPath(data: string, width: number, height: number) {
  const contours = flattenEvenOddPath(data);
  const alpha = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sampleX = x + 0.5;
      const sampleY = y + 0.5;
      let inside = false;
      for (const points of contours) {
        for (
          let index = 0, previous = points.length - 1;
          index < points.length;
          previous = index, index += 1
        ) {
          const start = points[index];
          const end = points[previous];
          if (
            start[1] > sampleY !== end[1] > sampleY &&
            sampleX <
              ((end[0] - start[0]) * (sampleY - start[1])) /
                (end[1] - start[1]) +
                start[0]
          ) {
            inside = !inside;
          }
        }
      }
      alpha[y * width + x] = inside ? 1 : 0;
    }
  }

  return alpha;
}

function decodeAlphaReference(reference: AlphaReference) {
  const packed = Buffer.from(reference.alpha, 'base64');
  if (packed.length * 8 !== reference.width * reference.height) {
    throw new Error('Malformed packed alpha reference');
  }
  const alpha = new Uint8Array(reference.width * reference.height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = (packed[index >> 3] >> (7 - (index & 7))) & 1;
  }
  return alpha;
}

function alphaBounds(
  alpha: Uint8Array,
  width: number,
  height: number,
): [number, number, number, number] {
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  for (let index = 0; index < alpha.length; index += 1) {
    if (alpha[index] === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
  }
  return [minimumX, minimumY, maximumX, maximumY];
}

function alphaComponents(alpha: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(alpha.length);
  const queue: number[] = [];
  let components = 0;

  for (let start = 0; start < alpha.length; start += 1) {
    if (alpha[start] === 0 || visited[start] !== 0) continue;
    components += 1;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      const x = index % width;
      const y = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          const next = nextY * width + nextX;
          if (
            nextX >= 0 &&
            nextX < width &&
            nextY >= 0 &&
            nextY < height &&
            alpha[next] !== 0 &&
            visited[next] === 0
          ) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }
  }

  return components;
}

function alphaIoU(reference: Uint8Array, candidate: Uint8Array) {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < reference.length; index += 1) {
    if (reference[index] !== 0 && candidate[index] !== 0) intersection += 1;
    if (reference[index] !== 0 || candidate[index] !== 0) union += 1;
  }
  return intersection / union;
}

describe('Leviathan brand assets', () => {
  it('ships the compact frost-dragon trace and Yggdrasill platform assets', () => {
    const mark = readFileSync(markPath, 'utf8');
    const imageAssets = readdirSync(publicDirectory)
      .filter((name) => /\.(?:png|svg)$/u.test(name))
      .sort();

    expect(imageAssets).toEqual([
      'leviathan-mark.svg',
      'yggdrasill-favicon.png',
      'yggdrasill.png',
    ]);
    expect(statSync(markPath).size).toBeLessThan(8 * 1024);
    expect(mark).toContain(
      '<title id="title">Leviathan frost-dragon mark</title>',
    );
    expect(mark).toMatch(/viewBox="0\s+0\s+64\s+64"/u);
    expect(mark).toMatch(/role="img"/u);
    expect(mark).toMatch(/aria-labelledby="title"/u);
    expect(mark).toContain(`data-source-sha256="${sourceSha256}"`);

    const silhouette = requiredPath(mark, 'dragon-silhouette');
    expect(svgPaths(mark)).toHaveLength(1);
    expect(silhouette.data.match(/M/gu)).toHaveLength(5);
    expect(silhouette.data.length).toBeGreaterThan(3_500);
    expect(attribute(silhouette.tag, 'class')?.split(/\s+/u)).toContain('mark');
    expect(attribute(silhouette.tag, 'fill-rule')).toBe('evenodd');

    expect(mark).toMatch(/\.mark\s*\{\s*fill:\s*#15364b\s*\}/u);
    expect(mark).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*\.mark\s*\{\s*fill:\s*#8be4ff\s*\}\s*\}/u,
    );
    const palette = [...mark.matchAll(/#[0-9a-f]{3,8}\b/giu)].map(([color]) =>
      color.toLowerCase(),
    );
    expect(palette).toEqual(['#15364b', '#8be4ff']);
    expect(mark).not.toMatch(/<rect\b|\bstroke=|\bopacity=/iu);
    expect(mark).not.toMatch(/\bbackground(?:-color)?\s*:/iu);
    expect(mark).not.toMatch(
      /<(?:script|foreignObject|iframe|object|embed|image|text)\b|\bon\w+\s*=|javascript:/iu,
    );
    expect(mark).not.toMatch(
      /<(?:animate(?:Motion|Transform)?|set|linearGradient|radialGradient|pattern|filter)\b/iu,
    );
    expect(mark).not.toMatch(
      /(?:href|xlink:href)\s*=|url\(\s*['"]?(?:data:|https?:|\/\/)/iu,
    );
    expect(existsSync(`${publicDirectory}/miglens-mark.png`)).toBe(false);
    expect(existsSync(`${publicDirectory}/favicon.svg`)).toBe(false);
  });

  it('matches the authorized packed alpha reference', () => {
    const mark = readFileSync(markPath, 'utf8');
    const silhouette = requiredPath(mark, 'dragon-silhouette');
    const reference = JSON.parse(
      readFileSync(referencePath, 'utf8'),
    ) as AlphaReference;

    expect(statSync(referencePath).size).toBeLessThan(2 * 1024);
    expect(Object.keys(reference).sort()).toEqual(
      [
        'alpha',
        'bbox',
        'components',
        'encoding',
        'height',
        'sampling',
        'sourceSha256',
        'threshold',
        'width',
      ].sort(),
    );
    expect(reference).toMatchObject({
      width: 64,
      height: 64,
      threshold: 128,
      sampling: 'nearest-center',
      encoding: 'row-major-msb-alpha1-base64',
      sourceSha256,
      components: 4,
    });
    expect(
      existsSync(resolve(publicDirectory, 'leviathan-mark-alpha.json')),
    ).toBe(false);

    const sourceAlpha = decodeAlphaReference(reference);
    const tracedAlpha = rasterizeEvenOddPath(
      silhouette.data,
      reference.width,
      reference.height,
    );
    expect(alphaComponents(sourceAlpha, 64, 64)).toBe(reference.components);
    expect(alphaComponents(tracedAlpha, 64, 64)).toBe(reference.components);
    const tracedBounds = alphaBounds(tracedAlpha, 64, 64);
    tracedBounds.forEach((value, index) => {
      expect(Math.abs(value - reference.bbox[index])).toBeLessThanOrEqual(1);
    });
    expect(alphaIoU(sourceAlpha, tracedAlpha)).toBeGreaterThanOrEqual(0.98);
  });

  it('uses the mark and Leviathan metadata in the document shell', () => {
    const document = readFileSync(indexPath, 'utf8');

    expect(document).toContain('href="/leviathan-mark.svg"');
    expect(document).toContain('<title>Leviathan · GPU monitor</title>');
    expect(document).not.toContain('miglens-mark');
  });
});
