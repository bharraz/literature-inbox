/**
 * The only place that touches Obsidian's file and network APIs.
 *
 * Everything under `core/` is deliberately free of Obsidian imports so it can
 * be unit-tested; this module is the seam. Both adapters are the
 * review-mandated implementations: the Vault API rather than Node `fs` (so
 * the plugin works on mobile and never escapes the vault), and `requestUrl`
 * rather than `fetch` (which would hit CORS).
 */

import { Notice, TFile, normalizePath, requestUrl, type App, type Vault } from "obsidian";
import type { Transport, TransportResponse } from "./core/http";
import { USER_AGENT } from "./core/http";
import type { VaultAdapter } from "./core/update";

export class ObsidianTransport implements Transport {
  async get(url: string): Promise<TransportResponse> {
    const response = await requestUrl({
      url,
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, application/xml, text/xml" },
      // Non-2xx must come back as a value, not an exception, so getWithRetry
      // can decide what is retryable.
      throw: false,
    });
    return { status: response.status, text: response.text };
  }
}

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly vault: Vault) {}

  async read(path: string): Promise<string | undefined> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) return undefined;
    return this.vault.read(file);
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      // Skip byte-identical writes: rewriting unchanged notes would bump their
      // mtime and make Obsidian's indexer and any sync tool churn through the
      // whole inbox on every run.
      if ((await this.vault.read(existing)) === content) return;
      await this.vault.modify(existing, content);
      return;
    }
    await this.ensureFolder(normalized.split("/").slice(0, -1).join("/"));
    await this.vault.create(normalized, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  async list(folder: string): Promise<string[]> {
    const prefix = `${normalizePath(folder)}/`;
    return this.vault
      .getFiles()
      .filter((file) => file.path.startsWith(prefix) && file.extension === "md")
      .map((file) => file.path);
  }

  async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    const normalized = normalizePath(path);
    if (this.vault.getAbstractFileByPath(normalized)) return;
    try {
      await this.vault.createFolder(normalized);
    } catch {
      // Racing with another creation is fine; anything else surfaces on write.
    }
  }
}

/** Move a note to Obsidian's trash — honouring the user's "deleted files"
 * preference — rather than deleting it. Cleanup must always be recoverable. */
export async function trashNote(app: App, path: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (file instanceof TFile) {
    await app.fileManager.trashFile(file);
  }
}

/** Move a note between folders. Uses `fileManager.renameFile` rather than the
 * raw vault rename so Obsidian rewrites every wikilink pointing at it — which
 * is exactly what makes "keep by moving the file" safe. */
export async function moveNote(app: App, from: string, to: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(normalizePath(from));
  if (!(file instanceof TFile)) return false;
  const targetFolder = to.split("/").slice(0, -1).join("/");
  if (targetFolder && !app.vault.getAbstractFileByPath(normalizePath(targetFolder))) {
    await app.vault.createFolder(normalizePath(targetFolder));
  }
  await app.fileManager.renameFile(file, normalizePath(to));
  return true;
}

export function notify(message: string, durationMs = 6000): void {
  new Notice(message, durationMs);
}
