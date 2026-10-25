import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCAN_UPLOAD_MAX_ATTEMPTS,
  SCAN_UPLOAD_RETRY_DELAYS_MS,
  ScanUploadQueue,
} from '../lib/scanUploadQueueCore.ts';

class MemoryQueueStorage {
  files = new Map();
  entries = [];

  async load() {
    return structuredClone(this.entries);
  }

  async save(entries) {
    this.entries = structuredClone(entries);
  }

  async copyFile(sourceUri, id, fileName) {
    const uri = `file:///durable/${id}/${fileName}`;
    this.files.set(uri, sourceUri);
    return uri;
  }

  async deleteFile(uri) {
    this.files.delete(uri);
  }
}

const makeScan = (sourceUri = 'file:///temporary/deck.ply') => ({
  sourceUri,
  fileName: 'deck.ply',
  fileSize: 4096,
  moduleType: 'DeckOps',
  technicianId: 'tech-123',
  timestamp: '2026-10-25T08:00:00.000Z',
  vesselAssetName: 'North Star',
});

test('keeps a timed-out scan and metadata across restart, then retries idempotently', async () => {
  const storage = new MemoryQueueStorage();
  let now = 1_000_000;
  let loseFirstResponse = true;
  const serverRecords = new Map();
  const receivedKeys = [];
  const upload = async (item) => {
    receivedKeys.push(item.id);
    let recordId = serverRecords.get(item.id);
    if (!recordId) {
      recordId = `record-${serverRecords.size + 1}`;
      serverRecords.set(item.id, recordId);
    }
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error('simulated VSAT timeout after server commit');
    }
    return { id: recordId };
  };

  const requestId = '11111111-1111-4111-8111-111111111111';
  const firstRun = new ScanUploadQueue(
    storage,
    upload,
    () => requestId,
    () => now,
  );
  const queued = await firstRun.enqueue(makeScan());
  await firstRun.flushDue('tech-123');

  const afterTimeout = firstRun.getSnapshot()[0];
  assert.equal(afterTimeout.state, 'pending');
  assert.equal(afterTimeout.attempts, 1);
  assert.equal(afterTimeout.vesselAssetName, 'North Star');
  assert.equal(storage.files.has(afterTimeout.fileUri), true);
  assert.equal(
    firstRun.nextRetryDelay('tech-123'),
    SCAN_UPLOAD_RETRY_DELAYS_MS[0],
  );

  const restartedApp = new ScanUploadQueue(
    storage,
    upload,
    () => 'unused-id',
    () => now,
  );
  await restartedApp.load();
  const restored = restartedApp.getSnapshot()[0];
  assert.equal(restored.id, queued.id);
  assert.equal(restored.fileName, 'deck.ply');
  assert.equal(restored.vesselAssetName, 'North Star');

  now += SCAN_UPLOAD_RETRY_DELAYS_MS[0];
  await restartedApp.flushDue('tech-123');
  const sent = restartedApp.getSnapshot()[0];
  assert.equal(sent.state, 'sent');
  assert.equal(sent.serverRecordId, 'record-1');
  assert.equal(serverRecords.size, 1);
  assert.deepEqual(receivedKeys, [requestId, requestId]);
  assert.equal(storage.files.has(afterTimeout.fileUri), false);
});

test('uses capped retries, reports failed, and preserves the file until manual retry succeeds', async () => {
  const storage = new MemoryQueueStorage();
  let now = 2_000_000;
  let offline = true;
  const queue = new ScanUploadQueue(
    storage,
    async (item) => {
      if (offline) throw new Error('simulated connection unavailable');
      return { id: `record-${item.id}` };
    },
    () => '22222222-2222-4222-8222-222222222222',
    () => now,
  );

  await queue.enqueue(makeScan('file:///temporary/tooling.ply'));
  for (let attempt = 1; attempt <= SCAN_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    await queue.flushDue('tech-123');
    const item = queue.getSnapshot()[0];
    assert.equal(item.attempts, attempt);
    assert.equal(storage.files.has(item.fileUri), true);
    if (item.state === 'pending') {
      const delay =
        SCAN_UPLOAD_RETRY_DELAYS_MS[
          Math.min(attempt - 1, SCAN_UPLOAD_RETRY_DELAYS_MS.length - 1)
        ];
      assert.equal(queue.nextRetryDelay('tech-123'), delay);
      now += delay;
    }
  }

  const failed = queue.getSnapshot()[0];
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attempts, SCAN_UPLOAD_MAX_ATTEMPTS);
  assert.equal(queue.nextRetryDelay('tech-123'), null);

  offline = false;
  assert.equal(await queue.retry(failed.id, 'tech-123'), true);
  await queue.flushDue('tech-123');
  const sent = queue.getSnapshot()[0];
  assert.equal(sent.state, 'sent');
  assert.equal(sent.attempts, 0);
  assert.equal(storage.files.has(failed.fileUri), false);
});
