import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoStore } from './db.js';
import { COLLECTIONS } from './models.js';

let mongod: MongoMemoryServer;
const store = new MongoStore();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await store.connect(mongod.getUri(), 'argus-test');
}, 120000);

afterAll(async () => { await store.close(); await mongod.stop(); });

describe('mongodb models/integration', () => {
  test('indexes enforce (sessionId,eventId) idempotency', async () => {
    const ev = store.col<any>(COLLECTIONS.evidence);
    const doc = { evidenceId: 'ev-1', sessionId: 'insp-1', eventId: 'img-1', sourceId: 'camera-01', sequence: 1, mediaType: 'photo', synthetic: true, filename: '1.png', size: 3, sha256: 'x', at: new Date().toISOString(), processingStatus: 'queued' };
    await ev.insertOne({ ...doc });
    await expect(ev.insertOne({ ...doc, evidenceId: 'ev-2' })).rejects.toThrow(/duplicate key/);
  });

  test('syncState + loadState round-trips all collections', async () => {
    await store.syncState({
      inspections: [{ id: 'insp-1', name: 'Run', model_id: 'CVS6000_VALVE', cadRevision: 'demo-1', cadSha256: 'abc', lifecycleStatus: 'WAITING', outcome: 'PENDING', createdAt: new Date().toISOString(), counts: { evidence: 1, video: 0, photo: 1, pointcloud: 0 } }],
      evidence: [], findings: [], events: [{ eventSeq: 1, sessionId: 'insp-1', type: 'inspection.created', at: new Date().toISOString() }], dossiers: [],
    });
    const loaded = await store.loadState();
    expect(loaded?.inspections[0].id).toBe('insp-1');
    expect(loaded?.events[0].type).toBe('inspection.created');
    const insp = await store.col<any>(COLLECTIONS.inspections).findOne({ id: 'insp-1' });
    expect(insp.lifecycleStatus).toBe('WAITING');
  });
});

import { mergeStates } from './db.js';
describe('mergeStates', () => {
  test('union by key; primary wins on clashes; nothing dropped', () => {
    const remote: any = { inspections: [{ id: 'a', name: 'remote A' }, { id: 'b', name: 'B' }], evidence: [], findings: [], events: [{ sessionId: 'a', eventSeq: 1 }], dossiers: [] };
    const local: any = { inspections: [{ id: 'a', name: 'local A' }, { id: 'c', name: 'C' }], evidence: [], findings: [], events: [{ sessionId: 'c', eventSeq: 1 }], dossiers: [] };
    const m: any = mergeStates(local, remote);
    expect(m.inspections.map((i: any) => i.id).sort()).toEqual(['a', 'b', 'c']);
    expect(m.inspections.find((i: any) => i.id === 'a').name).toBe('local A');
    expect(m.events).toHaveLength(2);
  });
});
