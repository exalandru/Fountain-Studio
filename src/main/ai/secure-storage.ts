import { safeStorage } from 'electron';

/**
 * Linux backends exposed by Electron's synchronous safeStorage API for the
 * version locked in this repository (Electron 43.x). Keep this list aligned
 * with `safeStorage.getSelectedStorageBackend()` in electron.d.ts — do not
 * copy docs from a newer Electron release without checking the lockfile.
 */
export type LinuxSafeStorageBackend =
  'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown';

const SECURE_LINUX_BACKENDS: ReadonlySet<LinuxSafeStorageBackend> = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);

export interface SecretStorageCapability {
  /**
   * Whether durable API-key persistence is acceptable for the selected backend.
   * Distinct from "encryption APIs are technically callable".
   */
  canPersistApiSecretsSecurely: boolean;
  /**
   * When true, any ciphertext already on disk must be moved to session memory
   * (if decryptable) and removed from durable storage — used for Linux
   * `basic_text`, which Electron documents as unprotected.
   */
  mustEvictPersistedSecrets: boolean;
}

/**
 * Pure policy for whether API secrets may be persisted. Unit tests exercise this
 * without Electron; production goes through {@link assessElectronSecretStorageCapability}.
 */
export function assessSecretStorageCapability(input: {
  platform: NodeJS.Platform;
  encryptionAvailable: boolean;
  linuxBackend?: LinuxSafeStorageBackend;
}): SecretStorageCapability {
  if (!input.encryptionAvailable) {
    return { canPersistApiSecretsSecurely: false, mustEvictPersistedSecrets: false };
  }
  if (input.platform !== 'linux') {
    // macOS Keychain / Windows DPAPI once encryption is available.
    return { canPersistApiSecretsSecurely: true, mustEvictPersistedSecrets: false };
  }

  const backend = input.linuxBackend ?? 'unknown';
  if (SECURE_LINUX_BACKENDS.has(backend)) {
    return { canPersistApiSecretsSecurely: true, mustEvictPersistedSecrets: false };
  }
  if (backend === 'basic_text') {
    return { canPersistApiSecretsSecurely: false, mustEvictPersistedSecrets: true };
  }
  // `unknown` (before app ready) and any future unrecognized backend: fail closed
  // for new persistence, but do not scrub existing ciphertext during a transient
  // undetermined window.
  return { canPersistApiSecretsSecurely: false, mustEvictPersistedSecrets: false };
}

/** Live Electron assessment for the current process. */
export function assessElectronSecretStorageCapability(): SecretStorageCapability {
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  if (process.platform !== 'linux') {
    return assessSecretStorageCapability({
      platform: process.platform,
      encryptionAvailable,
    });
  }
  // Avoid querying the backend before encryption is available (`unknown` pre-ready).
  if (!encryptionAvailable) {
    return assessSecretStorageCapability({ platform: 'linux', encryptionAvailable: false });
  }
  return assessSecretStorageCapability({
    platform: 'linux',
    encryptionAvailable: true,
    linuxBackend: safeStorage.getSelectedStorageBackend(),
  });
}
