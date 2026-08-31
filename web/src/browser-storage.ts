export function readBrowserSetting(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeBrowserSetting(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Preferences are optional when storage is disabled or unavailable.
  }
}

export function removeBrowserSetting(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Preferences are optional when storage is disabled or unavailable.
  }
}
