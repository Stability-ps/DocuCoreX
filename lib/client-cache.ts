// SECURITY (P0 data isolation): DocuCoreX caches per-user data (profile,
// notifications, document lists, upload queues) in session/localStorage under
// the "docucorex" key prefix. This data MUST be cleared when a session ends or
// a different user signs in, otherwise one user could briefly see the previous
// user's cached name, notifications or documents.
//
// Call clearDocucorexClientCache() on sign-out and on the login screen.

export function clearDocucorexClientCache() {
  if (typeof window === "undefined") return;

  const storages: Storage[] = [];
  try {
    storages.push(window.sessionStorage);
  } catch {
    // sessionStorage may be unavailable (privacy mode) — ignore.
  }
  try {
    storages.push(window.localStorage);
  } catch {
    // localStorage may be unavailable — ignore.
  }

  for (const storage of storages) {
    try {
      const keysToRemove: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && key.toLowerCase().startsWith("docucorex")) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => storage.removeItem(key));
    } catch {
      // Ignore storage access failures.
    }
  }
}
