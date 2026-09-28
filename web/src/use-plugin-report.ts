import { useCallback, useEffect, useRef, useState } from 'react';
import type { components } from './api.gen';

export type PluginReport = components['schemas']['PluginReport'];

function isPlugin(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const plugin = value as Partial<components['schemas']['PluginHealth']>;
  const optionalText = (text: unknown) =>
    text === undefined || typeof text === 'string';
  return (
    typeof plugin.id === 'string' &&
    typeof plugin.implementation === 'string' &&
    (plugin.transport === 'builtin' || plugin.transport === 'unix') &&
    typeof plugin.status === 'string' &&
    optionalText(plugin.message) &&
    typeof plugin.intervalMs === 'number' &&
    Number.isFinite(plugin.intervalMs) &&
    Array.isArray(plugin.dependencies) &&
    plugin.dependencies.every((id) => typeof id === 'string') &&
    Array.isArray(plugin.capabilities) &&
    plugin.capabilities.every(
      (capability) =>
        capability &&
        typeof capability.capability === 'string' &&
        typeof capability.revision === 'string' &&
        typeof capability.enabled === 'boolean' &&
        typeof capability.status === 'string' &&
        optionalText(capability.message) &&
        optionalText(capability.observedAt) &&
        optionalText(capability.lastSuccess),
    )
  );
}

export function usePluginReport() {
  const [report, setReport] = useState<PluginReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const readRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => readRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      controller = new AbortController();
      timeout = setTimeout(() => controller?.abort(), 3_000);
      setPending(true);
      try {
        const response = await fetch('/api/v1/plugins', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Plugin status is unavailable.');
        const value = (await response.json()) as PluginReport;
        if (
          !value ||
          !Array.isArray(value.plugins) ||
          !value.plugins.every(isPlugin)
        )
          throw new Error('Plugin status is unavailable.');
        if (!disposed) {
          setReport(value);
          setError(null);
        }
      } catch {
        if (!disposed) setError('Plugin status is unavailable.');
      } finally {
        inFlight = false;
        clearTimeout(timeout);
        if (!disposed) {
          setPending(false);
          timer = setTimeout(() => void read(), 5_000);
        }
      }
    };
    readRef.current = () => void read();
    void read();
    return () => {
      disposed = true;
      readRef.current = () => {};
      controller?.abort();
      clearTimeout(timer);
      clearTimeout(timeout);
    };
  }, []);

  return { report, error, pending, refresh };
}
