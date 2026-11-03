/**
 * MongoDB models (data contracts) for Argus collections.
 * Field separation is normative (Spec §10.1): lifecycleStatus, outcome,
 * ruleStatus and deliveryStatus are never merged into one field.
 */
export interface InspectionDoc {
  id: string; // insp-...
  name: string;
  model_id: string;
  cadRevision: string;
  cadSha256: string;
  referenceSnapshotId?: string;
  family?: string;
  type?: string;
  lifecycleStatus: 'WAITING' | 'RECEIVING' | 'ANALYZING' | 'READY_TO_CLOSE' | 'FINALIZING' | 'COMPLETED' | 'TERMINATED';
  outcome: 'PENDING' | 'PASS' | 'WARNING' | 'FAIL' | 'INCONCLUSIVE';
  createdAt: string;
  closedAt?: string;
  producerComplete?: boolean;
  counts: { evidence: number; video: number; photo: number; pointcloud: number };
}

export interface EvidenceDoc {
  evidenceId: string;
  sessionId: string;
  eventId: string; // idempotency key is (sessionId, eventId)
  sourceId: string;
  sequence: number;
  relativeTimeMs?: number;
  mediaType: 'video' | 'photo' | 'pointcloud';
  synthetic: boolean;
  units?: string;
  coordinateFrame?: string;
  filename: string;
  size: number;
  sha256: string;
  gcsUri?: string | null;
  at: string;
  processingStatus: 'queued' | 'processing' | 'done' | 'failed';
}

export interface FindingDoc {
  findingId: string;
  revision: number;
  sessionId: string;
  ruleId: string;
  ruleStatus: 'NOT_INSPECTED' | 'ANALYZING' | 'PASS' | 'WARNING' | 'FAIL' | 'INSUFFICIENT_EVIDENCE' | 'NOT_APPLICABLE';
  featureId: string | null;
  evidenceIds: string[];
  observationIds: string[];
  reason: string;
  cadAnchor: unknown | null;
  at: string;
}

export interface EventDoc {
  eventSeq: number; // monotonic per session, persisted before SSE publish
  sessionId: string;
  type: string;
  at: string;
  evidenceId?: string;
  mediaType?: string;
  ruleId?: string;
}

export interface DossierDoc {
  sessionId: string;
  partial: boolean;
  outcome: InspectionDoc['outcome'];
  size: number;
  at: string;
  htmlPath: string;
  gcsUri?: string | null;
}

/** Rules pinned to one session at creation (Spec §5, PRD-06): the rule
 *  set every later analysis, citation and dossier reads. Revision > 1 only
 *  when an order document is attached while the session is still WAITING. */
export interface ReferenceSnapshotDoc {
  snapshotId: string;
  sessionId: string;
  revision: number;
  createdAt: string;
  library: { packId: string; revision: string | null };
  model: { model_id: string; display_name: string; family: string; type: string; end_connection: string; cadRevision: string; cadSha256: string };
  orderDocument: { documentId: string; name: string; sha256: string; orderNumber: string | null; ruleCount: number } | null;
  cascade: { library: number; valveType: number; customerSpec: number; orderRules: number; referenceOnly: number; filteredOut: number };
  rules: any[];
  sha256: string;
}

/** Customer specification / work order uploaded for one session. */
export interface SessionDocumentDoc {
  documentId: string;
  sessionId: string;
  kind: 'order';
  name: string;
  size: number;
  sha256: string;
  at: string;
  storagePath: string;
  extraction: { status: 'parsed' | 'failed'; pages?: number; orderNumber?: string | null; ruleCount?: number; error?: string; context?: string };
}

/** Raw tool/model output linked to evidence (e.g. SAM boxes + masks). */
export interface ObservationDoc {
  observationId: string;
  sessionId: string;
  evidenceId: string;
  kind: string;
  model?: string;
  at: string;
  payload: any;
}

export interface RuleLibraryDoc {
  ruleId: string;
  section: string;
  title: string;
  category: string;
  quote: string;
  source: string;
  page: number;
  features: string[];
  modalities: string[];
  applicability: 'APPROVED' | 'DEMO_ONLY' | 'REFERENCE_ONLY';
  thresholdMm?: number;
}

export const COLLECTIONS = {
  inspections: 'inspections',
  evidence: 'evidence',
  findings: 'findings',
  events: 'events',
  dossiers: 'dossiers',
  ruleLibrary: 'ruleLibrary',
  referenceSnapshots: 'referenceSnapshots',
  documents: 'documents',
  observations: 'observations',
} as const;
