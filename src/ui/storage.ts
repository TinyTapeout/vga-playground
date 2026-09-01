/** localStorage wrappers that tolerate private mode and disabled site data. */

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore: private mode / storage disabled.
  }
}

export function readStoredNumber(key: string, fallback: number): number {
  const raw = readStorage(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
