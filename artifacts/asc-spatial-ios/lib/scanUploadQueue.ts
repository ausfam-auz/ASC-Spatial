import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { uploadScan } from '@workspace/api-client-react';
import {
  ScanUploadQueue,
  type ScanUploadQueueItem,
  type ScanUploadQueueStorage,
} from './scanUploadQueueCore';

function getQueueDirectory(): Directory {
  if (Platform.OS === 'web') {
    throw new Error('The durable scan queue is available in the native app.');
  }
  return new Directory(Paths.document, 'asc-spatial', 'scan-upload-queue');
}

function getQueueStateFile(): File {
  return new File(getQueueDirectory(), 'queue.json');
}

function isQueueItem(value: unknown): value is ScanUploadQueueItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ScanUploadQueueItem>;
  return (
    typeof item.id === 'string' &&
    (typeof item.fileUri === 'string' || item.fileUri === undefined) &&
    typeof item.fileName === 'string' &&
    typeof item.fileSize === 'number' &&
    (item.moduleType === 'DeckOps' || item.moduleType === 'ToolingAudit') &&
    typeof item.technicianId === 'string' &&
    typeof item.timestamp === 'string' &&
    typeof item.vesselAssetName === 'string' &&
    (item.state === 'pending' ||
      item.state === 'uploading' ||
      item.state === 'failed' ||
      item.state === 'sent') &&
    typeof item.attempts === 'number' &&
    typeof item.nextAttemptAt === 'number' &&
    typeof item.createdAt === 'number' &&
    (typeof item.serverRecordId === 'string' ||
      item.serverRecordId === undefined)
  );
}

const storage: ScanUploadQueueStorage = {
  async load() {
    if (Platform.OS === 'web') return [];
    const queueStateFile = getQueueStateFile();
    if (!queueStateFile.exists) return [];
    const parsed: unknown = JSON.parse(await queueStateFile.text());
    if (!Array.isArray(parsed) || !parsed.every(isQueueItem)) {
      throw new Error('The saved scan upload queue is invalid.');
    }
    return parsed;
  },

  async save(items) {
    if (Platform.OS === 'web') {
      if (items.length === 0) return;
      throw new Error(
        'The durable scan queue is available in the native iOS app.',
      );
    }
    const queueDirectory = getQueueDirectory();
    const queueStateFile = new File(queueDirectory, 'queue.json');
    queueDirectory.create({ intermediates: true, idempotent: true });
    if (!queueStateFile.exists) {
      queueStateFile.create({ intermediates: true });
    }
    queueStateFile.write(JSON.stringify(items));
  },

  async copyFile(sourceUri, id, fileName) {
    if (Platform.OS === 'web') {
      throw new Error(
        'Use the ASC Spatial web app for browser uploads. Offline-safe queuing requires the native iOS app.',
      );
    }
    const queueDirectory = getQueueDirectory();
    queueDirectory.create({ intermediates: true, idempotent: true });
    const itemDirectory = new Directory(queueDirectory, id);
    itemDirectory.create({ intermediates: true, idempotent: true });
    const safeName =
      fileName.replace(/[\\/:\0]/g, '_').slice(-120) || 'scan.ply';
    const destination = new File(itemDirectory, safeName);
    await new File(sourceUri).copy(destination);
    return destination.uri;
  },

  async deleteFile(uri) {
    if (Platform.OS === 'web') return;
    const file = new File(uri);
    if (file.exists) file.delete();
  },
};

export const scanUploadQueue = new ScanUploadQueue(
  storage,
  async (item) => {
    if (!item.fileUri) throw new Error('The queued scan file is missing.');
    return uploadScan(
      {
        moduleType: item.moduleType,
        technicianId: item.technicianId,
        timestamp: item.timestamp,
        vesselAssetName: item.vesselAssetName,
        file: new File(item.fileUri),
      },
      { headers: { 'Idempotency-Key': item.id } },
    );
  },
  randomUUID,
);
