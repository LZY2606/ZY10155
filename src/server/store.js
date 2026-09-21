// SQLite 记录层：层、条目（带乐观锁版本）、合并计划（按指纹幂等）、已发布结果（单行原子切换）。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseLayer } from './parser.js';
import { sha256 } from './merge.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS layers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rank INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  content_sha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  layer_id INTEGER NOT NULL REFERENCES layers(id),
  line_no INTEGER NOT NULL,
  type TEXT NOT NULL,
  raw TEXT NOT NULL,
  spec TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS plans (
  fingerprint TEXT PRIMARY KEY,
  rules_version INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','frozen','published')),
  result TEXT NOT NULL,
  result_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS published (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  plan_fingerprint TEXT NOT NULL REFERENCES plans(fingerprint),
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function createStore(dbPath = ':memory:') {
  if (dbPath !== ':memory:') mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const store = {
    db,

    seedFromFixtures(fixturesDir) {
      const layersDir = join(fixturesDir, 'layers');
      const names = readdirSync(layersDir).filter((f) => f.endsWith('.sdc')).sort();
      // 层顺序由文件名数字前缀决定：01_baseline < 02_ip < 03_project
      const insertLayer = db.prepare('INSERT INTO layers (name, rank, source_path, content_sha) VALUES (?, ?, ?, ?)');
      const insertEntry = db.prepare('INSERT INTO entries (layer_id, line_no, type, raw, spec) VALUES (?, ?, ?, ?, ?)');
      db.exec('BEGIN');
      try {
        names.forEach((file, rank) => {
          const text = readFileSync(join(layersDir, file), 'utf8');
          const name = file.replace(/\.sdc$/, '').replace(/^\d+_/, '');
          const layerId = insertLayer.run(name, rank, join('fixtures', 'layers', file), sha256(text)).lastInsertRowid;
          for (const { lineNo, raw, spec } of parseLayer(text)) {
            insertEntry.run(layerId, lineNo, spec.type, raw, JSON.stringify(spec));
          }
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return names.length;
    },

    isSeeded() {
      return db.prepare('SELECT COUNT(*) AS n FROM layers').get().n > 0;
    },

    loadLayers() {
      const layers = db.prepare('SELECT * FROM layers ORDER BY rank').all();
      const entryStmt = db.prepare('SELECT * FROM entries WHERE layer_id = ? ORDER BY line_no');
      return layers.map((l) => ({
        id: l.id,
        name: l.name,
        rank: l.rank,
        sourcePath: l.source_path,
        contentSha: l.content_sha,
        entries: entryStmt.all(l.id).map((r) => ({
          id: r.id,
          lineNo: r.line_no,
          type: r.type,
          raw: r.raw,
          spec: JSON.parse(r.spec),
          disabled: !!r.disabled,
          version: r.version,
        })),
      }));
    },

    getEntry(id) {
      const r = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
      if (!r) return null;
      return { id: r.id, layerId: r.layer_id, lineNo: r.line_no, type: r.type, raw: r.raw, spec: JSON.parse(r.spec), disabled: !!r.disabled, version: r.version };
    },

    // 乐观锁：base_version 不匹配 -> 返回 { conflict: true, current }
    updateEntry(id, { clause, patterns, disabled }, baseVersion) {
      const current = store.getEntry(id);
      if (!current) return { notFound: true };
      if (baseVersion !== current.version) {
        return { conflict: true, current };
      }
      const spec = { ...current.spec };
      if (clause && patterns !== undefined) {
        if (clause === 'targets' && spec.targets) spec.targets = { ...spec.targets, patterns };
        else if (clause === 'from' && spec.from) spec.from = { ...spec.from, patterns };
        else if (clause === 'to' && spec.to) spec.to = { ...spec.to, patterns };
        else if (clause === 'through' && spec.through) spec.through = { ...spec.through, patterns };
        else return { error: `条目没有可编辑的子句 "${clause}"` };
      }
      const res = db.prepare(
        'UPDATE entries SET spec = ?, disabled = ?, version = version + 1, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ? AND version = ?',
      ).run(JSON.stringify(spec), disabled === undefined ? (current.disabled ? 1 : 0) : (disabled ? 1 : 0), id, baseVersion);
      if (res.changes === 0) return { conflict: true, current: store.getEntry(id) };
      return { entry: store.getEntry(id) };
    },

    // 幂等：同指纹直接复用已有计划
    savePlan(fingerprint, rulesVersion, asOf, result, resultFingerprint) {
      db.prepare(
        'INSERT OR IGNORE INTO plans (fingerprint, rules_version, as_of, result, result_fingerprint) VALUES (?, ?, ?, ?, ?)',
      ).run(fingerprint, rulesVersion, asOf, JSON.stringify(result), resultFingerprint);
      return store.getPlan(fingerprint);
    },

    getPlan(fingerprint) {
      const r = db.prepare('SELECT * FROM plans WHERE fingerprint = ?').get(fingerprint);
      if (!r) return null;
      return { fingerprint: r.fingerprint, rulesVersion: r.rules_version, asOf: r.as_of, status: r.status, result: JSON.parse(r.result), resultFingerprint: r.result_fingerprint, createdAt: r.created_at };
    },

    freezePlan(fingerprint) {
      const plan = store.getPlan(fingerprint);
      if (!plan) return { notFound: true };
      if (plan.status === 'published') return { error: '已发布的计划不可修改状态' };
      db.prepare("UPDATE plans SET status = 'frozen' WHERE fingerprint = ?").run(fingerprint);
      return { plan: store.getPlan(fingerprint) };
    },

    // 事务化发布：冻结计划 -> 原子切换 published 单行；任何失败整体回滚，
    // 不会出现一部分 endpoint 已采用新结果而另一部分仍是旧结果。
    publishPlan(fingerprint) {
      const plan = store.getPlan(fingerprint);
      if (!plan) return { notFound: true };
      if (plan.status !== 'frozen') return { error: '仅冻结状态的计划可发布' };
      if (plan.result.diagnostics.some((d) => d.code === 'clock-cycle' || d.code === 'ambiguous-source' || d.code === 'unknown-source' || d.code === 'duplicate-clock')) {
        return { error: '计划含时钟图错误，禁止发布' };
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE plans SET status = 'published' WHERE fingerprint = ?").run(fingerprint);
        db.prepare('INSERT INTO published (id, plan_fingerprint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET plan_fingerprint = excluded.plan_fingerprint, published_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')').run(fingerprint);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { published: store.getPublished() };
    },

    getPublished() {
      const r = db.prepare('SELECT * FROM published WHERE id = 1').get();
      if (!r) return null;
      return { planFingerprint: r.plan_fingerprint, publishedAt: r.published_at, plan: store.getPlan(r.plan_fingerprint) };
    },
  };
  return store;
}

export function loadRules(fixturesDir) {
  const p = join(fixturesDir, 'rules.json');
  const raw = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  return {
    rulesVersion: raw.rulesVersion ?? 1,
    broadMatchThreshold: raw.broadMatchThreshold ?? 8,
    asOf: raw.asOf ?? new Date().toISOString().slice(0, 10),
  };
}
