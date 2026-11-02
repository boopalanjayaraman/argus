import { MongoClient, type Db, type Collection } from 'mongodb';
import { COLLECTIONS, type InspectionDoc, type EvidenceDoc, type FindingDoc, type EventDoc, type DossierDoc } from './models.js';

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
  }

  col<T extends object>(name: string): Collection<T> {
    if (!this.db) throw new Error('MongoStore not connected');
    return this.db.collection<T>(name);
  }

  /** Replace-collection sync of the API working state (keeps server code
   *  unchanged while making Mongo the durable store when configured). */
  async syncState(state: { inspections: InspectionDoc[]; evidence: EvidenceDoc[]; findings: FindingDoc[]; events: EventDoc[]; dossiers: DossierDoc[] }) {
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
  }

  async loadState() {
    if (!this.db) return null;
    const get = async (name: string) => this.db!.collection(name).find({}, { projection: { _id: 0 } }).toArray();
    const [inspections, evidence, findings, events, dossiers] = await Promise.all([
      get(COLLECTIONS.inspections), get(COLLECTIONS.evidence), get(COLLECTIONS.findings), get(COLLECTIONS.events), get(COLLECTIONS.dossiers),
    ]);
    if (!inspections.length && !evidence.length && !events.length) return null;
    return { inspections, evidence, findings, events, dossiers } as unknown as { inspections: InspectionDoc[]; evidence: EvidenceDoc[]; findings: FindingDoc[]; events: EventDoc[]; dossiers: DossierDoc[] };
  }

  async close() { await this.client?.close(); this.client = null; this.db = null; }
}

export const mongoStore = new MongoStore();
