import type { AlignedHistory, AlignedHistoryRequest } from './types';

const maxBodyBytes = 256 * 1024;
const maxSeries = 256;
const maxMetrics = 1024;
const maxConcurrentRequests = 4;
const encoder = new TextEncoder();

function splitRequest(request: AlignedHistoryRequest): AlignedHistoryRequest[] {
  const emptyBytes = encoder.encode(
    JSON.stringify({ ...request, series: [] }),
  ).length;
  const batches: AlignedHistoryRequest[] = [];
  const keys = new Set<string>();
  let series: AlignedHistoryRequest['series'] = [];
  let bytes = emptyBytes;
  let metrics = 0;
  for (const descriptor of request.series) {
    if (keys.has(descriptor.key))
      throw new Error('Aligned history series keys must be unique.');
    keys.add(descriptor.key);
    const descriptorBytes = encoder.encode(JSON.stringify(descriptor)).length;
    if (emptyBytes + descriptorBytes > maxBodyBytes)
      throw new Error('Aligned history series exceeds the request size limit.');
    if (
      series.length &&
      (series.length === maxSeries ||
        metrics + descriptor.metrics.length > maxMetrics ||
        bytes + descriptorBytes + 1 > maxBodyBytes)
    ) {
      batches.push({ ...request, series });
      series = [];
      bytes = emptyBytes;
      metrics = 0;
    }
    bytes += descriptorBytes + (series.length ? 1 : 0);
    metrics += descriptor.metrics.length;
    series.push(descriptor);
  }
  if (series.length || !batches.length) batches.push({ ...request, series });
  return batches;
}

function compareTimestamps(left: string, right: string) {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds) return milliseconds;
  // Preserve distinct RFC3339 nanosecond samples within the same millisecond.
  const fraction = (value: string) =>
    (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(9, '0');
  return fraction(left).localeCompare(fraction(right));
}

function mergeResponses(responses: AlignedHistory[]): AlignedHistory {
  if (responses.length === 1) return responses[0];
  const points = new Map<string, AlignedHistory['points'][number]>();
  for (const response of responses) {
    for (const point of response.points) {
      const previous = points.get(point.sampledAt);
      points.set(point.sampledAt, {
        sampledAt: point.sampledAt,
        values: { ...previous?.values, ...point.values },
      });
    }
  }
  return {
    window: responses[0].window,
    series: responses.flatMap((response) => response.series),
    points: [...points.values()].sort((left, right) =>
      compareTimestamps(left.sampledAt, right.sampledAt),
    ),
  };
}

/** Keep caller keys and explicit gaps across bounded, cancellable HTTP requests. */
export async function fetchAlignedHistory(
  request: AlignedHistoryRequest,
  signal?: AbortSignal,
): Promise<AlignedHistory> {
  const batches = splitRequest(request);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const responses: AlignedHistory[] = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      controller.signal.throwIfAborted();
      const index = next++;
      const response = await fetch('/api/v1/history/aligned', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batches[index]),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Aligned history request failed (${response.status})`);
      responses[index] = (await response.json()) as AlignedHistory;
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrentRequests, batches.length) },
        worker,
      ),
    );
    return mergeResponses(responses);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
