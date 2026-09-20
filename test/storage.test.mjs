import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { addEdit, freezePlan, getOrCreatePlan, openStorage, publishPlan, upsertCase } from '../src/server/storage.mjs';

const files = [];
function tempDb() {
  const file = path.join(tmpdir(), `sdc-${Math.random().toString(16).slice(2)}.sqlite`);
  files.push(file);
  return openStorage(file);
}

const design = {
  id: 'case-x',
  name: 'storage case',
  ruleVersion: '1.0.0',
  ports: ['CLK'],
  cells: [],
  pins: ['A/q', 'B/d'],
  paths: [{ id: 'p1', from: 'A/q', to: 'B/d', launchClock: 'clk', captureClock: 'clk' }]
};
const layers = [
  { id: 'baseline', content: `create_clock -name clk -period 10 [get_ports CLK]
set_multicycle_path 2 -setup -from [get_pins A/q] -to [get_pins B/d]
set_multicycle_path 1 -hold -from [get_pins A/q] -to [get_pins B/d]` },
  { id: 'project', content: 'set_false_path -from [get_pins A/q] -to [get_pins B/d]' }
];

afterEach(() => {
  for (const file of files) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  }
});

describe('SQLite plans', () => {
  it('is idempotent for the same input layers, as-of date, and rule version', () => {
    const db = tempDb();
    upsertCase(db, { design, layers });
    const first = getOrCreatePlan(db, 'case-x', '2026-09-21').plan;
    const second = getOrCreatePlan(db, 'case-x', '2026-09-21').plan;
    expect(first.id).toBe(second.id);
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
  });

  it('returns object-level revision conflicts', () => {
    const db = tempDb();
    upsertCase(db, { design, layers });
    const plan = getOrCreatePlan(db, 'case-x', '2026-09-21').plan;
    const edit = { type: 'disable_exception', targetEntryId: 'project:set_false_path:1' };
    expect(addEdit(db, plan.id, edit).objectRevision).toBe(1);
    const stale = addEdit(db, plan.id, { ...edit, expectedObjectRevision: 0 });
    expect(stale.error.status).toBe(409);
    expect(stale.error.body.error).toBe('object_conflict');
  });

  it('publishes frozen endpoint outcomes atomically', () => {
    const db = tempDb();
    upsertCase(db, { design, layers });
    const plan = getOrCreatePlan(db, 'case-x', '2026-09-21').plan;
    expect(freezePlan(db, plan.id).plan.status).toBe('frozen');
    const published = publishPlan(db, plan.id).plan;
    expect(published.status).toBe('published');
    const outcome = db.prepare('SELECT * FROM endpoint_outcomes WHERE case_id = ? AND endpoint_id = ?').get('case-x', 'p1');
    expect(JSON.parse(outcome.published_json).conclusion).toBe('false_path');
    expect(Number(outcome.release_id)).toBeGreaterThan(0);
  });
});
