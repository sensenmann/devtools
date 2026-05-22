import fs from "node:fs";
import path from "node:path";

import { DB_FILENAME, DB_METADATA_FILENAME } from "./constants.ts";
import { downloadDatabase, fetchRemoteMetadata, formatNetworkError } from "./network.ts";
import type { DatabaseAvailabilityContext, DatabaseAvailabilityResult, DatabaseMetadata, OwaspDependencyCheckConfig } from "./types.ts";

export async function ensureDatabaseAvailable(
  config: Pick<OwaspDependencyCheckConfig, "dbUrl" | "cacheDir" | "ignoreSsl">,
  context: DatabaseAvailabilityContext,
): Promise<DatabaseAvailabilityResult> {
  fs.mkdirSync(config.cacheDir, { recursive: true });
  const dbPath = path.join(config.cacheDir, DB_FILENAME);
  const metaPath = path.join(config.cacheDir, DB_METADATA_FILENAME);
  const hasLocalDb = fs.existsSync(dbPath);

  if ((context.batchProjectIndex ?? 0) > 0 && hasLocalDb) {
    return { success: true, message: `Reused cached database at ${dbPath}` };
  }

  let remoteMetadata: DatabaseMetadata | undefined;
  try {
    remoteMetadata = await fetchRemoteMetadata(config.dbUrl, config.ignoreSsl, context.signal);
  } catch (error) {
    const details = formatNetworkError("Database metadata request", config.dbUrl, config.ignoreSsl, error);
    if (hasLocalDb) {
      return {
        success: true,
        message: `Using cached ODC database because metadata check failed. ${details}`,
      };
    }
    return {
      success: false,
      message: `Could not validate or download the ODC database. ${details}`,
    };
  }

  const localMetadata = loadDatabaseMetadata(metaPath);
  if (hasLocalDb && isDatabaseCurrent(localMetadata, remoteMetadata)) {
    return { success: true, message: `Reused cached database at ${dbPath}` };
  }

  context.log?.(`[download] ${config.dbUrl} -> ${dbPath}`);
  try {
    process.stdout.write(`Downloading ODC database from ${config.dbUrl}\n`);
    let lastPercent = -1;
    let showedProgressLine = false;
    await downloadDatabase(config.dbUrl, dbPath, config.ignoreSsl, context.signal, (downloadedBytes, totalBytes) => {
      showedProgressLine = true;
      if (!totalBytes || totalBytes <= 0) {
        process.stdout.write(`\rDownloading ODC database: ${formatMegabytes(downloadedBytes)} MB downloaded`);
        return;
      }
      const percent = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
      if (percent === lastPercent && percent !== 100) {
        return;
      }
      lastPercent = percent;
      process.stdout.write(`\rDownloading ODC database: ${percent}% (${formatMegabytes(downloadedBytes)} / ${formatMegabytes(totalBytes)} MB)`);
    });
    if (showedProgressLine) {
      process.stdout.write("\n");
    }
    saveDatabaseMetadata(metaPath, {
      ...remoteMetadata,
      checkedAt: new Date().toISOString(),
    });
    return { success: true, message: `Downloaded ODC database to ${dbPath}` };
  } catch (error) {
    process.stdout.write("\n");
    const details = formatNetworkError("Database download", config.dbUrl, config.ignoreSsl, error);
    if (hasLocalDb) {
      return {
        success: true,
        message: `Using cached ODC database because refresh failed. ${details}`,
      };
    }
    return {
      success: false,
      message: `Failed to download the ODC database. ${details}`,
    };
  }
}

export function isDatabaseCurrent(localMetadata: DatabaseMetadata | undefined, remoteMetadata: DatabaseMetadata | undefined): boolean {
  if (!localMetadata || !remoteMetadata) {
    return false;
  }
  if (localMetadata.etag && remoteMetadata.etag) {
    return localMetadata.etag === remoteMetadata.etag;
  }
  if (localMetadata.lastModified && remoteMetadata.lastModified) {
    return localMetadata.lastModified === remoteMetadata.lastModified;
  }
  return false;
}

function loadDatabaseMetadata(metaPath: string): DatabaseMetadata | undefined {
  if (!fs.existsSync(metaPath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(metaPath, "utf8")) as DatabaseMetadata;
}

function saveDatabaseMetadata(metaPath: string, metadata: DatabaseMetadata): void {
  fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
