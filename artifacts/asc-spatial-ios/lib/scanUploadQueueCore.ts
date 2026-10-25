export const SCAN_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const SCAN_UPLOAD_MAX_ATTEMPTS = 6;
export const SCAN_UPLOAD_RETRY_DELAYS_MS = [
  15_000, 45_000, 120_000, 300_000, 600_000, 600_000,
] as const;

export type ScanUploadState = 'pending' | 'uploading' | 'failed' | 'sent';
export type ScanUploadModuleType = 'DeckOps' | 'ToolingAudit';

export interface ScanUploadQueueItem {
  id: string;
  fileUri?: string;
  fileName: string;
  fileSize: number;
  moduleType: ScanUploadModuleType;
  technicianId: string;
  timestamp: string;
  vesselAssetName: string;
  state: ScanUploadState;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  serverRecordId?: string;
  lastError?: string;
}

export interface NewScanUpload {
  sourceUri: string;
  fileName: string;
  fileSize: number;
  moduleType: ScanUploadModuleType;
  technicianId: string;
  timestamp: string;
  vesselAssetName: string;
}

export interface ScanUploadQueueStorage {
  load(): Promise<ScanUploadQueueItem[]>;
  save(items: ScanUploadQueueItem[]): Promise<void>;
  copyFile(sourceUri: string, id: string, fileName: string): Promise<string>;
  deleteFile(uri: string): Promise<void>;
}

export type ScanUploadHandler = (
  item: ScanUploadQueueItem,
) => Promise<{ id: string }>;

type QueueListener = (items: ScanUploadQueueItem[]) => void;

function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

export class ScanUploadQueue {
  private items: ScanUploadQueueItem[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private flushPromise: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<QueueListener>();
  private readonly storage: ScanUploadQueueStorage;
  private readonly upload: ScanUploadHandler;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(
    storage: ScanUploadQueueStorage,
    upload: ScanUploadHandler,
    createId: () => string,
    now: () => number = Date.now,
  ) {
    this.storage = storage;
    this.upload = upload;
    this.createId = createId;
    this.now = now;
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ScanUploadQueueItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      const stored = await this.storage.load();
      const currentTime = this.now();
      let changed = false;
      const recovered = stored.map((item) => {
        if (item.state !== 'uploading') return item;
        changed = true;
        return {
          ...item,
          state: 'pending' as const,
          nextAttemptAt: currentTime,
        };
      });

      if (changed) await this.storage.save(recovered);
      this.items = recovered;
      this.loaded = true;
      this.emit();
      await this.cleanupAcknowledgedFiles();
    })();

    try {
      await this.loadPromise;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    }
  }

  async enqueue(scan: NewScanUpload): Promise<ScanUploadQueueItem> {
    await this.load();
    const extension = extensionOf(scan.fileName);
    if (extension !== 'ply' && extension !== 'obj') {
      throw new Error('Only .ply and .obj scan files can be queued.');
    }
    if (!Number.isFinite(scan.fileSize) || scan.fileSize < 0) {
      throw new Error('The scan file size could not be determined.');
    }
    if (scan.fileSize > SCAN_UPLOAD_MAX_BYTES) {
      throw new Error('The scan exceeds the 100 MiB upload limit.');
    }

    const id = this.createId();
    if (this.items.some((item) => item.id === id)) {
      throw new Error('A duplicate local upload identifier was generated.');
    }

    const fileUri = await this.storage.copyFile(
      scan.sourceUri,
      id,
      scan.fileName,
    );
    const item: ScanUploadQueueItem = {
      id,
      fileUri,
      fileName: scan.fileName,
      fileSize: scan.fileSize,
      moduleType: scan.moduleType,
      technicianId: scan.technicianId,
      timestamp: scan.timestamp,
      vesselAssetName: scan.vesselAssetName,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: this.now(),
      createdAt: this.now(),
    };

    try {
      await this.commit((items) => [...items, item]);
    } catch (error) {
      await this.storage.deleteFile(fileUri).catch(() => undefined);
      throw error;
    }
    return { ...item };
  }

  async flushDue(technicianId: string): Promise<void> {
    await this.load();
    if (this.flushPromise) return this.flushPromise;

    this.flushPromise = this.runDue(technicianId);
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  nextRetryDelay(technicianId: string): number | null {
    const nextAttemptAt = this.items
      .filter(
        (item) =>
          item.technicianId === technicianId && item.state === 'pending',
      )
      .reduce<number | null>(
        (earliest, item) =>
          earliest === null
            ? item.nextAttemptAt
            : Math.min(earliest, item.nextAttemptAt),
        null,
      );
    return nextAttemptAt === null
      ? null
      : Math.max(0, nextAttemptAt - this.now());
  }

  async retry(id: string, technicianId: string): Promise<boolean> {
    await this.load();
    const item = this.items.find((candidate) => candidate.id === id);
    if (
      !item ||
      item.technicianId !== technicianId ||
      item.state !== 'failed'
    ) {
      return false;
    }

    await this.updateItem(id, (current) => ({
      ...current,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: this.now(),
      lastError: undefined,
    }));
    return true;
  }

  private async runDue(technicianId: string): Promise<void> {
    const candidates = this.getSnapshot();
    for (const candidate of candidates) {
      if (
        candidate.technicianId !== technicianId ||
        candidate.state !== 'pending' ||
        candidate.nextAttemptAt > this.now()
      ) {
        continue;
      }

      if (!candidate.fileUri) {
        await this.updateItem(candidate.id, (item) => ({
          ...item,
          state: 'failed',
          attempts: SCAN_UPLOAD_MAX_ATTEMPTS,
          nextAttemptAt: 0,
          lastError: 'The saved scan file is missing from this device.',
        }));
        continue;
      }

      await this.updateItem(candidate.id, (item) => ({
        ...item,
        state: 'uploading',
        lastError: undefined,
      }));
      const uploadingItem = this.items.find((item) => item.id === candidate.id);
      if (!uploadingItem) continue;

      try {
        const response = await this.upload({ ...uploadingItem });
        if (!response?.id)
          throw new Error('The server did not confirm the scan.');

        await this.updateItem(candidate.id, (item) => ({
          ...item,
          state: 'sent',
          serverRecordId: response.id,
          nextAttemptAt: 0,
          lastError: undefined,
        }));

        const sentItem = this.items.find((item) => item.id === candidate.id);
        if (sentItem?.fileUri) {
          try {
            await this.storage.deleteFile(sentItem.fileUri);
            await this.updateItem(candidate.id, (item) => ({
              ...item,
              fileUri: undefined,
            }));
          } catch {
            // Keep the acknowledged file path so a later app start can retry cleanup.
          }
        }
      } catch {
        const attemptCount = candidate.attempts + 1;
        const state =
          attemptCount >= SCAN_UPLOAD_MAX_ATTEMPTS ? 'failed' : 'pending';
        const retryDelay =
          SCAN_UPLOAD_RETRY_DELAYS_MS[
            Math.min(attemptCount - 1, SCAN_UPLOAD_RETRY_DELAYS_MS.length - 1)
          ];
        await this.updateItem(candidate.id, (item) => {
          if (item.state === 'sent') return item;
          return {
            ...item,
            state,
            attempts: attemptCount,
            nextAttemptAt: state === 'pending' ? this.now() + retryDelay : 0,
            lastError: 'Upload failed. The local scan is still saved.',
          };
        });
      }
    }
  }

  private async cleanupAcknowledgedFiles(): Promise<void> {
    for (const item of this.items) {
      if (item.state !== 'sent' || !item.fileUri) continue;
      try {
        await this.storage.deleteFile(item.fileUri);
        await this.updateItem(item.id, (current) => ({
          ...current,
          fileUri: undefined,
        }));
      } catch {
        // The API already acknowledged this scan; preserve the pointer for another cleanup attempt.
      }
    }
  }

  private async updateItem(
    id: string,
    update: (item: ScanUploadQueueItem) => ScanUploadQueueItem,
  ): Promise<void> {
    await this.commit((items) =>
      items.map((item) => (item.id === id ? update(item) : item)),
    );
  }

  private async commit(
    update: (items: ScanUploadQueueItem[]) => ScanUploadQueueItem[],
  ): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const next = update(this.getSnapshot());
      await this.storage.save(next);
      this.items = next;
      this.emit();
    });
    this.writeTail = operation.catch(() => undefined);
    await operation;
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
