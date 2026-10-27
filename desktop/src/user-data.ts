import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface UserDataResolution {
  path: string;
  migratedFrom?: string;
  migrationError?: string;
}

/**
 * Eve owns its Electron profile. Existing SuWen data is adopted once by an
 * atomic directory rename so the old and new applications never share a
 * single-instance lock, daemon connection, or browser profile.
 *
 * If Windows refuses the rename (for example while an old daemon still owns a
 * file), the legacy directory is left untouched and Eve starts in its own
 * profile. This avoids silently mixing profiles or deleting user history.
 */
export function resolveUserData(options: {
  appData: string;
  testHome?: string;
  legacyName?: string;
  productName?: string;
}): UserDataResolution {
  if (options.testHome) return { path: options.testHome };
  const productPath = join(options.appData, options.productName ?? 'Eve');
  if (existsSync(productPath)) return { path: productPath };
  const legacyPath = join(options.appData, options.legacyName ?? 'SuWen');
  if (!existsSync(legacyPath)) return { path: productPath };
  try {
    renameSync(legacyPath, productPath);
    return { path: productPath, migratedFrom: legacyPath };
  } catch (error) {
    return {
      path: productPath,
      migrationError: error instanceof Error ? error.message : String(error),
    };
  }
}
