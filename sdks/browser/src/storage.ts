import type { ChertoStorage } from "./types.js";

/** A {@link ChertoStorage} whose methods never throw. */
export interface SafeStorage {
  getItem(key: string): string | null;
  /** Whether the value was stored. */
  setItem(key: string, value: string): boolean;
  removeItem(key: string): void;
}

/**
 * The storage option resolved: `null` stores nothing, `undefined` uses `localStorage`, and
 * anything else must have all three methods. `localStorage` is looked up on each use, so
 * nothing touches it before there is something to read or save.
 */
export function resolveStorage(
  option: ChertoStorage | null | undefined,
  onInvalid: (message: string) => void,
): SafeStorage | null {
  if (option === null) return null;
  // Reading `localStorage` throws where site data is blocked.
  if (option === undefined) return guard(() => globalThis.localStorage);
  const candidate = option as Partial<ChertoStorage>;
  if (
    typeof candidate.getItem !== "function" ||
    typeof candidate.setItem !== "function" ||
    typeof candidate.removeItem !== "function"
  ) {
    onInvalid("storage must have getItem, setItem and removeItem methods, or be null");
    return null;
  }
  return guard(() => option);
}

function guard(storageOf: () => ChertoStorage | null | undefined): SafeStorage {
  const use = <T>(work: (storage: ChertoStorage) => T, fallback: T): T => {
    try {
      const storage = storageOf();
      return storage ? work(storage) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    getItem: (key) =>
      use((storage) => {
        const value = storage.getItem(key);
        return typeof value === "string" ? value : null;
      }, null),
    setItem: (key, value) =>
      use((storage) => {
        storage.setItem(key, value);
        return true;
      }, false),
    removeItem: (key) => use((storage) => storage.removeItem(key), undefined),
  };
}
