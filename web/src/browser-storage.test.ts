import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBrowserSetting, writeBrowserSetting } from './browser-storage';

describe('browser preferences', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads and writes only the requested minimal value', () => {
    writeBrowserSetting('leviathan.theme.v1', 'light');
    expect(readBrowserSetting('leviathan.theme.v1')).toBe('light');
  });

  it('remains usable when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage disabled');
    });

    expect(readBrowserSetting('leviathan.theme.v1')).toBeNull();
    expect(() =>
      writeBrowserSetting('leviathan.theme.v1', 'dark'),
    ).not.toThrow();
  });
});
