import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Rule library indexer + session rule selection (PRD-02, PRD-06).
 *
 * Sources: src/inspection_rules/*.md, parsed into individual rules from
 * `ID: text` lines (NP-001, GEO-002, ...), numbered checklist table rows
 * (2.1, 2.2, ...), bullets and semicolon checklist paragraphs. Indexing
 * metadata (stage, evidence, equipment narrowing, approved scan thresholds)
 * comes from src/reference-data/rule-metadata.json. The index is written
 * once to src/reference-data/rule-library.json (`npm run index:rules`) and
 * runtime reads only that file. Same sources + metadata = same revision.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const RULES_DIR = path.join(root, 'src/inspection_rules');
export const METADATA_FILE = path.join(root, 'src/reference-data/rule-metadata.json');
export const INDEX_FILE = path.join(root, 'src/reference-data/rule-library.json');
/** Bump when parsing changes so the index revision changes with it. */
export const INDEXER_VERSION = 2;
const STAGE_ORDER = ['Visual Inspection', 'Identification', 'Assembly', 'Functional Testing', 'Release Gates', 'Global Rules'];

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

function parseDocument(file: string, text: string, docMeta: any) {
  const title = (text.match(/^#\s+(.+)$/m) || [])[1] || file.replace(/\.md$/, '');
  const stage = docMeta.stage || 'Global Rules';
  const evidence = docMeta.evidence || 'Work order record';
  const slug = file.replace(/\.md$/, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 18);
  const rules: any[] = [];
  let section = title.replace(/^Inspection - |^Assembly - /, '');
  const sectionNotes: Record<string, string> = {};
  const push = (r: any) => rules.push({ line: '', reference: '', note: '', evidence, document: file, category: stage, stage, section, source: title, ...r });
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const h = line.match(/^##\s+(?:\d+\.\s*)?(.+)$/);
    if (h) { section = h[1].trim(); continue; }
    const rej = line.match(/^\*\*Reject if:\*\*\s*(.+)$/i);
    if (rej) sectionNotes[section] = `Reject if: ${rej[1]}`;
    const m = line.match(/^([A-Z][A-Z0-9]*-\d{3,}|TAG-\d{3}|CRN-\d{3})[:\s]+(.{10,})$/);
    if (m) { push({ ruleId: m[1], code: m[1], title: m[2].trim(), text: m[2].trim() }); continue; }
    const para = line.length > 60 && !line.startsWith('#') && !line.startsWith('>') && !line.startsWith('|') && !line.startsWith('Source:') && line.includes(';');
    if (para) {
      for (const item of line.split(';').map(x => x.trim()).filter(x => x.length > 15)) {
        const code = `${slug}-${String(rules.length + 1).padStart(2, '0')}`;
        push({ ruleId: code, code, title: item.slice(0, 90), text: item });
      }
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.{15,})$/);
    if (bullet && !line.startsWith('|')) {
      const code = `${slug}-${String(rules.length + 1).padStart(2, '0')}`;
      push({ ruleId: code, code, title: bullet[1].trim().slice(0, 90), text: bullet[1].trim() });
      continue;
    }
    const cells = line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (/^\d+\.\d+$/.test(cells[0] || '') && cells.length >= 4 && !/Inspection Item/i.test(cells[1] || '')) {
      push({ ruleId: cells[0], code: cells[0], title: cells[1], line: cells[3], text: cells[3], reference: cells[2] });
    }
  }
  for (const r of rules) if (sectionNotes[r.section]) r.note = sectionNotes[r.section];
  return { title, stage, evidence, rules };
}

/** Build the index from sources + metadata. Deterministic (no timestamps). */
export function buildRuleIndex(dir = RULES_DIR, metadataFile = METADATA_FILE) {
  const meta = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort() : [];
  const documents: any[] = []; const rules: any[] = []; const sources: any[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const docMeta = meta.documents?.[file] || {};
    const doc = parseDocument(file, text, docMeta);
    const docSha = sha256(text);
    sources.push({ file, sha256: docSha });
    for (const r of doc.rules) {
      const override = meta.rules?.[r.ruleId] || {};
      const modalities: string[] = meta.evidenceModalities?.[r.evidence] || [];
      const equipment = {
        family: override.family || docMeta.family || meta.defaultEquipment.family,
        types: override.types || docMeta.types || meta.defaultEquipment.types,
        endConnections: override.endConnections || docMeta.endConnections || meta.defaultEquipment.endConnections,
      };
      rules.push({
        ...r, quote: r.text, sourceSha256: docSha, modalities, equipment,
        applicability: modalities.length ? (override.applicability || docMeta.applicability || 'APPROVED') : 'REFERENCE_ONLY',
        ...(override.threshold ? { threshold: override.threshold, approval: override.approval || null } : {}),
        ...(override.prerequisites ? { prerequisites: override.prerequisites } : {}),
        ...(override.onFail ? { onFail: override.onFail } : {}),
        ...(override.why ? { equipmentWhy: override.why } : {}),
        features: [], origin: 'library',
      });
    }
    documents.push({ file, title: doc.title, stage: doc.stage, evidence: doc.evidence, ruleCount: doc.rules.length, sha256: docSha });
  }
  // Rule IDs are join keys for findings: a code printed in two documents
  // (e.g. a size row "DN65-100" in two regulator sheets) is qualified by
  // its document so each stays individually addressable.
  const seen = new Map<string, number>();
  for (const r of rules) seen.set(r.ruleId, (seen.get(r.ruleId) || 0) + 1);
  for (const r of rules) if ((seen.get(r.ruleId) || 0) > 1) r.ruleId = `${r.code}@${r.document.replace(/\.md$/, '')}`;
  const byStage = new Map<string, any[]>();
  for (const r of rules) { if (!byStage.has(r.stage)) byStage.set(r.stage, []); byStage.get(r.stage)!.push(r); }
  const stages = STAGE_ORDER.filter(s => byStage.has(s)).map(name => {
    const rs = byStage.get(name)!;
    const sections = [...new Set(rs.map(r => r.section))].map(sec => ({ name: sec, count: rs.filter(r => r.section === sec).length, note: (rs.find(r => r.section === sec && r.note) || {}).note || '' }));
    return { name, count: rs.length, sections };
  });
  const categories: Record<string, number> = {};
  for (const s of stages) categories[s.name] = s.count;
  const metadataSha256 = sha256(fs.readFileSync(metadataFile));
  const revision = sha256(JSON.stringify({ sources, metadataSha256, indexer: INDEXER_VERSION })).slice(0, 16);
  return { packId: 'inspection-rules-library', revision, indexerVersion: INDEXER_VERSION, metadataSha256, sources, documents, rules, stages, counts: { documents: documents.length, rules: rules.length, categories } };
}

export function writeRuleIndex(out = INDEX_FILE) {
  const index = buildRuleIndex();
  fs.writeFileSync(out, JSON.stringify(index, null, 2) + '\n');
  return index;
}

let cached: { mtime: number; index: any } | null = null;
/** The indexed library (runtime never parses the markdown sources). */
export function loadRuleIndex(file = INDEX_FILE): any {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (!cached || cached.mtime !== mtime) cached = { mtime, index: JSON.parse(fs.readFileSync(file, 'utf8')) };
    return cached.index;
  } catch {
    return { packId: 'inspection-rules-library', revision: null, sources: [], documents: [], rules: [], stages: [], counts: { documents: 0, rules: 0, categories: {} } };
  }
}

const norm = (v: string) => String(v || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
const includes = (list: string[] | undefined, value: string) => !list || list.includes('*') || list.map(norm).includes(norm(value));

/** Does a library rule apply to this equipment (family / subtype / ends)? */
export function equipmentMatches(rule: any, model: any): boolean {
  const eq = rule.equipment || {};
  if (eq.family && norm(eq.family) !== norm(model.family)) return false;
  return includes(eq.types, model.type) && includes(eq.endConnections, model.end_connection);
}

export const evaluable = (r: any) => r.applicability !== 'REFERENCE_ONLY' && (r.modalities || []).length > 0;

/** Session rule selection: library -> valve type -> customer specification.
 * Step 2 keeps rules whose equipment matches the pinned CAD model; step 3
 * keeps those Argus can evaluate from session evidence and adds the order
 * rules printed in an uploaded customer document. */
export function selectSessionRules(index: any, model: any, orderDocument: any | null) {
  const typeMatched = index.rules.filter((r: any) => equipmentMatches(r, model));
  const orderRules = (orderDocument?.rules || []).map((r: any) => ({
    ...r, origin: 'order', document: orderDocument.name, source: `${orderDocument.orderNumber || 'Customer order'} (${orderDocument.name})`,
    section: `Customer order ${orderDocument.orderNumber || ''}`.trim(), code: r.ruleId,
    stage: 'Customer order', category: 'Customer order', evidence: r.evidenceText || '', equipment: null,
  }));
  const rules = [...typeMatched, ...orderRules];
  const selected = rules.filter(evaluable);
  return {
    cascade: {
      library: index.rules.length,
      valveType: typeMatched.length,
      customerSpec: selected.length,
      orderRules: orderRules.filter(evaluable).length,
      referenceOnly: rules.length - selected.length,
      filteredOut: index.rules.length - typeMatched.length,
    },
    rules,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const index = writeRuleIndex();
  console.log(`Indexed ${index.counts.rules} rules from ${index.counts.documents} documents -> ${path.relative(root, INDEX_FILE)} (revision ${index.revision})`);
}
