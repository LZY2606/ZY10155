import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { sha256, stableStringify } from '../core/canonical.mjs';
import { RULE_VERSION, mergeConstraints } from '../core/merge.mjs';
import { parseDateBoundary } from '../core/parser.mjs';
import { changedEndpoints, analyzeEndpoints } from '../core/endpoints.mjs';

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  design_json TEXT NOT NULL,
  layers_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  status TEXT NOT NULL CHECK(status IN ('draft','frozen','published')),
  as_of TEXT NOT NULL,
  base_fingerprint TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  frozen_at TEXT,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS plan_edits (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('change_pattern','disable_exception')),
  target_entry_id TEXT NOT NULL,
  field TEXT,
  collection_index INTEGER,
  pattern TEXT,
  object_key TEXT NOT NULL,
  object_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_snapshots (
  plan_id TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
  merged_json TEXT NOT NULL,
  endpoints_json TEXT NOT NULL,
  frozen_fingerprint TEXT NOT NULL,
  frozen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id),
  frozen_fingerprint TEXT NOT NULL,
  endpoint_count INTEGER NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS endpoint_outcomes (
  case_id TEXT NOT NULL REFERENCES cases(id),
  endpoint_id TEXT NOT NULL,
  release_id INTEGER REFERENCES releases(id),
  baseline_json TEXT NOT NULL,
  current_json TEXT,
  published_json TEXT,
  PRIMARY KEY(case_id, endpoint_id)
);
`;

export function openStorage(filePath = process.env.SDC_DB_PATH ?? path.resolve('data/sdc.sqlite')) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA);
  return db;
}

export function upsertCase(db, fixture) {
  const design = { ...fixture.design, ruleVersion: fixture.design.ruleVersion ?? RULE_VERSION };
  const layers = fixture.layers.map((layer) => ({ id: layer.id, content: layer.content }));
  db.prepare(`
    INSERT INTO cases(id, name, rule_version, design_json, layers_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      rule_version=excluded.rule_version,
      design_json=excluded.design_json,
      layers_json=excluded.layers_json
  `).run(design.id, design.name, design.ruleVersion, JSON.stringify(design), JSON.stringify(layers));
  return getCase(db, design.id);
}

export function getCase(db, caseId) {
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!row) return null;
  return { ...row, design: JSON.parse(row.design_json), layers: JSON.parse(row.layers_json) };
}

export function listCases(db) {
  return db.prepare('SELECT id, name, rule_version FROM cases ORDER BY id').all();
}

function baseFingerprint(caseRow, asOf) {
  return sha256({
    caseId: caseRow.id,
    ruleVersion: caseRow.rule_version,
    asOf,
    design: caseRow.design,
    layers: caseRow.layers
  });
}

function currentEdits(db, planId) {
  return db.prepare(`
    SELECT * FROM plan_edits
    WHERE plan_id = ? AND status = 'active'
    ORDER BY created_at, id
  `).all(planId).map((row) => ({
    id: row.id,
    type: row.type,
    targetEntryId: row.target_entry_id,
    field: row.field,
    collectionIndex: row.collection_index,
    pattern: row.pattern,
    objectKey: row.object_key,
    objectRevision: row.object_revision
  }));
}

function computeCase(caseRow, edits, asOf) {
  const merged = mergeConstraints({
    design: caseRow.design,
    layers: caseRow.layers,
    edits,
    asOf,
    ruleVersion: caseRow.rule_version
  });
  const endpoints = analyzeEndpoints(caseRow.design, merged);
  return { merged, endpoints };
}

function planResponse(db, row, caseRow) {
  const edits = currentEdits(db, row.id);
  const baseline = computeCase(caseRow, [], row.as_of);
  const current = computeCase(caseRow, edits, row.as_of);
  const snapshot = db.prepare('SELECT * FROM plan_snapshots WHERE plan_id = ?').get(row.id);
  return {
    id: row.id,
    caseId: row.case_id,
    status: row.status,
    asOf: row.as_of,
    ruleVersion: row.rule_version ?? caseRow.rule_version,
    baseFingerprint: row.base_fingerprint,
    inputFingerprint: row.input_fingerprint,
    revision: row.revision,
    edits,
    merged: current.merged,
    endpoints: current.endpoints,
    changedEndpoints: changedEndpoints(baseline.endpoints, current.endpoints),
    frozen: snapshot ? JSON.parse(snapshot.merged_json) : null,
    frozenEndpoints: snapshot ? JSON.parse(snapshot.endpoints_json) : null,
    createdAt: row.created_at,
    frozenAt: row.frozen_at,
    publishedAt: row.published_at
  };
}

export function getOrCreatePlan(db, caseId, asOf) {
  if (!parseDateBoundary(asOf)) {
    return { error: { status: 400, body: { error: 'invalid_as_of_date' } } };
  }
  const caseRow = getCase(db, caseId);
  if (!caseRow) return { error: { status: 404, body: { error: 'case_not_found' } } };
  const fingerprint = baseFingerprint(caseRow, asOf);
  const existing = db.prepare("SELECT * FROM plans WHERE case_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1").get(caseId);
  if (existing && existing.base_fingerprint === fingerprint) {
    return { plan: planResponse(db, existing, caseRow) };
  }
  const id = `plan_${fingerprint.slice(0, 16)}`;
  db.prepare(`
    INSERT INTO plans(id, case_id, status, as_of, base_fingerprint, input_fingerprint, created_at)
    VALUES (?, ?, 'draft', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(id, caseId, asOf, fingerprint, fingerprint, new Date().toISOString());
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  return { plan: planResponse(db, row, caseRow) };
}

export function getPlan(db, planId) {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!row) return null;
  const caseRow = getCase(db, row.case_id);
  return planResponse(db, row, caseRow);
}

function editableObjectKey(edit) {
  if (edit.type === 'disable_exception') return `exception:${edit.targetEntryId}`;
  return `pattern:${edit.targetEntryId}:${edit.field}:${edit.collectionIndex}`;
}

function nextObjectRevision(db, planId, key) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(object_revision), 0) + 1 AS revision
    FROM plan_edits WHERE plan_id = ? AND object_key = ?
  `).get(planId, key);
  return row.revision;
}

export function addEdit(db, planId, editInput) {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!row) return { error: { status: 404, body: { error: 'plan_not_found' } } };
  if (row.status !== 'draft') return { error: { status: 409, body: { error: 'plan_not_editable' } } };
  const caseRow = getCase(db, row.case_id);
  const current = computeCase(caseRow, currentEdits(db, planId), row.as_of);
  const target = current.merged.entries.find((entry) => entry.id === editInput.targetEntryId);
  if (!target) return { error: { status: 404, body: { error: 'target_entry_not_found' } } };
  if (editInput.type === 'change_pattern') {
    const fieldAllowed = ['targets', 'sources', 'from', 'to', 'through'].includes(editInput.field);
    const group = target.objectBindings?.[editInput.field];
    if (!fieldAllowed || !Array.isArray(group) || editInput.collectionIndex < 0 || editInput.collectionIndex >= group.length) {
      return { error: { status: 400, body: { error: 'invalid_pattern_target' } } };
    }
    if (typeof editInput.pattern !== 'string' || editInput.pattern.length === 0) {
      return { error: { status: 400, body: { error: 'invalid_pattern' } } };
    }
  }
  const draftEdit = { ...editInput };
  const key = editableObjectKey(draftEdit);
  const objectRevision = Number(editInput.expectedObjectRevision ?? 0);
  const latest = db.prepare(`
    SELECT object_revision AS revision FROM plan_edits
    WHERE plan_id = ? AND object_key = ?
    ORDER BY object_revision DESC LIMIT 1
  `).get(planId, key);
  if (latest && objectRevision !== latest.revision) {
    return {
      error: {
        status: 409,
        body: { error: 'object_conflict', objectKey: key, expectedObjectRevision: objectRevision, currentObjectRevision: latest.revision }
      }
    };
  }
  const revision = nextObjectRevision(db, planId, key);
  const edit = {
    id: `edit_${sha256({ planId, ...editInput, revision }).slice(0, 20)}`,
    ...editInput
  };
  db.prepare(`
    INSERT INTO plan_edits(
      id, plan_id, type, target_entry_id, field, collection_index, pattern,
      object_key, object_revision, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    edit.id,
    planId,
    edit.type,
    edit.targetEntryId,
    edit.field ?? null,
    edit.collectionIndex ?? null,
    edit.pattern ?? null,
    key,
    revision,
    new Date().toISOString()
  );
  db.prepare('UPDATE plans SET revision = revision + 1, input_fingerprint = ? WHERE id = ?').run(
    sha256([row.base_fingerprint, stableStringify(currentEdits(db, planId))]),
    planId
  );
  return { plan: getPlan(db, planId), objectKey: key, objectRevision: revision };
}

export function freezePlan(db, planId) {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!row) return { error: { status: 404, body: { error: 'plan_not_found' } } };
  if (row.status === 'published') return { error: { status: 409, body: { error: 'plan_published' } } };
  if (row.status === 'frozen') return { plan: getPlan(db, planId) };
  const caseRow = getCase(db, row.case_id);
  const current = computeCase(caseRow, currentEdits(db, planId), row.as_of);
  const frozenFingerprint = sha256({ base: row.base_fingerprint, input: current.merged.inputFingerprint });
  const frozenAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO plan_snapshots(plan_id, merged_json, endpoints_json, frozen_fingerprint, frozen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(planId, JSON.stringify(current.merged), JSON.stringify(current.endpoints), frozenFingerprint, frozenAt);
  db.prepare("UPDATE plans SET status='frozen', frozen_at=?, input_fingerprint=? WHERE id=?")
    .run(frozenAt, frozenFingerprint, planId);
  return { plan: getPlan(db, planId) };
}

export function publishPlan(db, planId) {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!row) return { error: { status: 404, body: { error: 'plan_not_found' } } };
  if (row.status === 'published') return { plan: getPlan(db, planId) };
  if (row.status !== 'frozen') return { error: { status: 409, body: { error: 'plan_must_be_frozen' } } };
  const caseRow = getCase(db, row.case_id);
  const snapshot = db.prepare('SELECT * FROM plan_snapshots WHERE plan_id = ?').get(planId);
  if (!snapshot) return { error: { status: 409, body: { error: 'frozen_snapshot_missing' } } };
  const frozenEndpoints = JSON.parse(snapshot.endpoints_json);
  const baseline = computeCase(caseRow, [], row.as_of);

  const tx = db.prepare('BEGIN IMMEDIATE');
  try {
    tx.run();
    const publishedAt = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO releases(plan_id, frozen_fingerprint, endpoint_count, published_at)
      VALUES (?, ?, ?, ?)
    `).run(planId, snapshot.frozen_fingerprint, frozenEndpoints.length, publishedAt);
    const releaseId = Number(info.lastInsertRowid);
    const baselineById = new Map(baseline.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    for (const endpoint of frozenEndpoints) {
      db.prepare(`
        INSERT INTO endpoint_outcomes(case_id, endpoint_id, release_id, baseline_json, current_json, published_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(case_id, endpoint_id) DO UPDATE SET
          release_id=excluded.release_id,
          current_json=excluded.current_json,
          published_json=excluded.published_json
      `).run(
        row.case_id,
        endpoint.id,
        releaseId,
        JSON.stringify(baselineById.get(endpoint.id) ?? null),
        JSON.stringify(endpoint),
        JSON.stringify(endpoint)
      );
    }
    db.prepare("UPDATE plans SET status='published', published_at=? WHERE id=?").run(publishedAt, planId);
    db.prepare('COMMIT').run();
  } catch (error) {
    db.prepare('ROLLBACK').run();
    throw error;
  }
  return { plan: getPlan(db, planId) };
}

export function previewEdit(db, planId, edit) {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!row) return { error: { status: 404, body: { error: 'plan_not_found' } } };
  const caseRow = getCase(db, row.case_id);
  const before = computeCase(caseRow, currentEdits(db, planId), row.as_of);
  const after = computeCase(caseRow, [...currentEdits(db, planId), { id: 'preview', ...edit }], row.as_of);
  return { changes: changedEndpoints(before.endpoints, after.endpoints), before: before.endpoints, after: after.endpoints };
}
