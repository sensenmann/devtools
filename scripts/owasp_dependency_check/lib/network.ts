import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import type { DatabaseMetadata } from "./types.ts";

interface RequestOptions {
  url: string;
  method: "HEAD" | "GET";
  ignoreSsl: boolean;
  signal?: AbortSignal;
  maxRedirects?: number;
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
  destinationPath?: string;
}

interface RequestResult {
  statusCode: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
}

export async function fetchRemoteMetadata(url: string, ignoreSsl: boolean, signal?: AbortSignal): Promise<DatabaseMetadata> {
  const response = await requestUrl({ url, method: "HEAD", ignoreSsl, signal, maxRedirects: 5 });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(buildHttpFailureMessage("HEAD", url, ignoreSsl, response));
  }
  return {
    etag: headerValue(response.headers.etag),
    lastModified: headerValue(response.headers["last-modified"]),
  };
}

export async function downloadDatabase(
  url: string,
  dbPath: string,
  ignoreSsl: boolean,
  signal?: AbortSignal,
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void,
): Promise<void> {
  const tmpPath = `${dbPath}.tmp`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try {
    const response = await requestUrl({
      url,
      method: "GET",
      ignoreSsl,
      signal,
      maxRedirects: 5,
      onProgress,
      destinationPath: tmpPath,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(buildHttpFailureMessage("GET", url, ignoreSsl, response));
    }
    fs.renameSync(tmpPath, dbPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function formatNetworkError(action: string, url: string, ignoreSsl: boolean, error: unknown): string {
  const proxyVars = [
    `HTTPS_PROXY=${process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "-"}`,
    `HTTP_PROXY=${process.env.HTTP_PROXY ?? process.env.http_proxy ?? "-"}`,
    `NO_PROXY=${process.env.NO_PROXY ?? process.env.no_proxy ?? "-"}`,
  ].join(", ");
  const chain = flattenErrorChain(error).join(" | ");
  return `${action} failed for ${url}. ignore_ssl=${ignoreSsl}. proxy_env=[${proxyVars}]. details=${chain}`;
}

function requestUrl(options: RequestOptions): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const maxRedirects = options.maxRedirects ?? 5;
    const url = new URL(options.url);
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const request = transport.request(
      url,
      {
        method: options.method,
        rejectUnauthorized: url.protocol === "https:" ? !options.ignoreSsl : undefined,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const statusMessage = response.statusMessage ?? "";
        const location = response.headers.location;
        if (location && isRedirectStatus(statusCode)) {
          response.resume();
          if (maxRedirects <= 0) {
            settled = true;
            reject(new Error(`Too many redirects while requesting ${options.url}`));
            return;
          }
          const redirectedUrl = new URL(location, url).toString();
          settled = true;
          requestUrl({ ...options, url: redirectedUrl, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
          return;
        }
        const totalBytes = Number(response.headers["content-length"] ?? 0) || undefined;
        const fileStream = options.destinationPath ? fs.createWriteStream(options.destinationPath) : undefined;
        const chunks: Buffer[] = [];
        let downloadedBytes = 0;

        const fail = (error: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          fileStream?.destroy();
          reject(error);
        };

        fileStream?.on("error", fail);
        response.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          downloadedBytes += buffer.length;
          options.onProgress?.(downloadedBytes, totalBytes);
          if (fileStream) {
            fileStream.write(buffer);
          } else {
            chunks.push(buffer);
          }
        });
        response.on("end", () => {
          if (fileStream) {
            fileStream.end(() => {
              if (settled) {
                return;
              }
              settled = true;
              resolve({
                statusCode,
                statusMessage,
                headers: response.headers,
              });
            });
            return;
          }
          if (settled) {
            return;
          }
          settled = true;
          void chunks;
          resolve({
            statusCode,
            statusMessage,
            headers: response.headers,
          });
        });
        response.on("error", (error) => {
          fail(error);
        });
      },
    );

    request.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(new Error("Request cancelled."));
      } else {
        options.signal.addEventListener("abort", () => {
          request.destroy(new Error("Request cancelled."));
        }, { once: true });
      }
    }
    request.end();
  });
}

function isRedirectStatus(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function flattenErrorChain(error: unknown): string[] {
  const parts: string[] = [];
  let current: unknown = error;
  while (current) {
    if (current instanceof Error) {
      const label = [current.name, errorCode(current), current.message].filter(Boolean).join(": ");
      parts.push(label);
      current = "cause" in current ? (current as Error & { cause?: unknown }).cause : undefined;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts;
}

function errorCode(error: Error): string {
  return String((error as Error & { code?: string }).code ?? "");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value ?? undefined;
}

function buildHttpFailureMessage(method: string, url: string, ignoreSsl: boolean, response: RequestResult): string {
  const proxyVars = [
    `HTTPS_PROXY=${process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "-"}`,
    `HTTP_PROXY=${process.env.HTTP_PROXY ?? process.env.http_proxy ?? "-"}`,
    `NO_PROXY=${process.env.NO_PROXY ?? process.env.no_proxy ?? "-"}`,
  ].join(", ");
  return `${method} ${url} failed with ${response.statusCode} ${response.statusMessage}. ignore_ssl=${ignoreSsl}. proxy_env=[${proxyVars}]`;
}
