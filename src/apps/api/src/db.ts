import { MongoClient, type Db, type Collection } from 'mongodb';
import { COLLECTIONS, type InspectionDoc, type EvidenceDoc, type FindingDoc, type EventDoc, type DossierDoc, type ReferenceSnapshotDoc, type SessionDocumentDoc, type ObservationDoc } from './models.js';

export interface StoreState { inspections: InspectionDoc[]; evidence: EvidenceDoc[]; findings: FindingDoc[]; events: EventDoc[]; dossiers: DossierDoc[]; referenceSnapshots?: ReferenceSnapshotDoc[]; documents?: SessionDocumentDoc[]; observations?: ObservationDoc[] }

/**
 * MongoDB integration (G-01).
 * Enabled when MONGODB_URI is set (see .env.template); otherwise the API
 * keeps its local-file store and this module stays disconnected.
 * The store mirrors the API's working state into real collections with the
 * indexes the spec requires; startup loads state back from Mongo when data
 * exists there, so restarts survive without data/db.json.
 */
export class MongoStore {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  get connected() { return this.db !== null; }

  async connect(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || 'argus'): Promise<boolean> {
    if (!uri) return false;
    this.client = new MongoClient(uri);
    await this.client.connect();
    this.db = this.client.db(dbName);
    await this.createIndexes();
    return true;
  }

  async createIndexes() {
    if (!this.db) return;
    await this.db.collection(COLLECTIONS.inspections).createIndex({ id: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.evidence).createIndex({ sessionId: 1, eventId: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.evidence).createIndex({ sessionId: 1 });
    await this.db.collection(COLLECTIONS.findings).createIndex({ sessionId: 1, ruleId: 1, revision: 1 });
    await this.db.collection(COLLECTIONS.events).createIndex({ sessionId: 1, eventSeq: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.dossiers).createIndex({ sessionId: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.referenceSnapshots).createIndex({ snapshotId: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.referenceSnapshots).createIndex({ sessionId: 1, revision: 1 });
    await this.db.collection(COLLECTIONS.documents).createIndex({ documentId: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.observations).createIndex({ sessionId: 1, evidenceId: 1 });
  }

  col<T extends object>(name: string): Collection<T> {
    if (!this.db) throw new Error('MongoStore not connected');
    return this.db.collection<T>(name);
  }

  /** Replace-collection sync of the API working state (keeps server code
   *  unchanged while making Mongo the durable store when configured). */
  async syncState(state: StoreState) {
    if (!this.db) return;
    const sync = async (name: string, docs: any[]) => {
      const c = this.db!.collection(name);
      await c.deleteMany({});
      if (docs.length) await c.insertMany(docs.map(d => ({ ...d })));
    };
    await sync(COLLECTIONS.inspections, state.inspections);
    await sync(COLLECTIONS.evidence, state.evidence);
    await sync(COLLECTIONS.findings, state.findings);
    await sync(COLLECTIONS.events, state.events);
    await sync(COLLECTIONS.dossiers, state.dossiers);
    await sync(COLLECTIONS.referenceSnapshots, state.referenceSnapshots || []);
    await sync(COLLECTIONS.documents, state.documents || []);
    await sync(COLLECTIONS.observations, state.observations || []);
  }

  async loadState() {
    if (!this.db) return null;
    const get = async (name: string) => this.db!.collection(name).find({}, { projection: { _id: 0 } }).toArray();
    const [inspections, evidence, findings, events, dossiers, referenceSnapshots, documents, observations] = await Promise.all([
      get(COLLECTIONS.inspections), get(COLLECTIONS.evidence), get(COLLECTIONS.findings), get(COLLECTIONS.events), get(COLLECTIONS.dossiers),
      get(COLLECTIONS.referenceSnapshots), get(COLLECTIONS.documents), get(COLLECTIONS.observations),
    ]);
    if (!inspections.length && !evidence.length && !events.length) return null;
    return { inspections, evidence, findings, events, dossiers, referenceSnapshots, documents, observations } as unknown as StoreState;
  }

  async close() { await this.client?.close(); this.client = null; this.db = null; }
}

export const mongoStore = new MongoStore();
