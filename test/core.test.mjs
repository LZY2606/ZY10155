import { describe, expect, it } from 'vitest';
import { globMatches, buildObjectIndex, resolveReference } from '../src/core/objects.mjs';
import { parseDateBoundary, parseLayer } from '../src/core/parser.mjs';
import { mergeConstraints, RULE_VERSION } from '../src/core/merge.mjs';
import { analyzeEndpoints } from '../src/core/endpoints.mjs';

const design = {
  ports: ['CLK', 'DIN[*]'],
  cells: ['U0', 'U0/U A'],
  pins: ['U0/Q', 'U0/D', 'U0/U A/pin'],
  paths: [{ id: 'p1', from: 'U0/Q', to: 'U0/D', launchClock: 'clk', captureClock: 'clk' }]
};

function merge(content, asOf = '2026-09-21', currentDesign = design) {
  const layer = { id: 'L', content };
  return mergeConstraints({ design: currentDesign, layers: [layer], asOf });
}

describe('SDC parser and hierarchy matching', () => {
  it('parses continuations and escaped hierarchy spaces', () => {
    const result = parseLayer({
      id: 'L',
      content: 'set_false_path \\\n  -from [get_pins U0/U\\ A/pin] -to [get_ports DIN\\[\\*\\]] # note'
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.entries[0].line).toBe('1-2');
    expect(result.entries[0].from[0].patterns[0]).toBe('U0/U\\ A/pin');
    expect(result.entries[0].to[0].patterns[0]).toBe('DIN\\[\\*\\]');
  });

  it('distinguishes literal empty, escaped single, and broad wildcard matches', () => {
    const index = buildObjectIndex(design);
    const empty = resolveReference({ kind: 'collection', command: 'get_pins', patterns: ['MISSING'] }, index, 1);
    const single = resolveReference({ kind: 'collection', command: 'get_pins', patterns: ['U0/U\\ A/pin'] }, index, 1);
    const broad = resolveReference({ kind: 'collection', command: 'get_pins', patterns: ['U0/*'] }, index, 1);
    expect(empty.status).toBe('empty');
    expect(single.status).toBe('single');
    expect(single.names).toEqual(['U0/U A/pin']);
    expect(broad.status).toBe('broad');
    expect(broad.names).toHaveLength(2);
  });

  it('uses half-open UTC date boundaries', () => {
    expect(parseDateBoundary('2026-09-21')).toBe('2026-09-21');
    const content = `create_clock -name clk -period 10 [get_ports CLK]
set_false_path -from [get_pins U0/Q] -to [get_pins U0/D] # @effective 2026-09-21`;
    expect(merge(content, '2026-09-20').entries.at(-1).dateStatus).toBe('future');
    expect(merge(content, '2026-09-21').entries.at(-1).dateStatus).toBe('active');
  });
});

describe('clock derivation', () => {
  it('rejects cycles even when generated clocks are declared across layers', () => {
    const result = merge(`create_clock -name clk -period 10 [get_ports CLK]
create_generated_clock -name a -source [get_pins U0/Q] -master_clock clk -divide_by 2 [get_pins U0/Q]
create_generated_clock -name b -source [get_pins U0/D] -master_clock a -divide_by 2 [get_pins U0/D]
create_generated_clock -name a -source [get_pins U0/D] -master_clock b -divide_by 2 [get_pins U0/D]`);
    expect(result.clockGraph.diagnostics.map((item) => item.code)).toContain('CLOCK_DERIVATION_CYCLE');
    expect(result.clockGraph.nodes.map((node) => node.name)).toEqual(['clk']);
    expect(result.clockGraph.rejected).toEqual(['a', 'b']);
    expect(result.clockGraph.edges).toEqual([]);
  });

  it('rejects an indistinguishable multi-source generated clock', () => {
    const ambiguousDesign = {
      ports: ['CLK'],
      cells: [],
      pins: ['U0/Q', 'U0/D', 'U0/X'],
      paths: []
    };
    const result = merge(`create_clock -name clk -period 10 [get_ports CLK]
create_generated_clock -name a -source [get_pins U0/Q] -master_clock clk -divide_by 2 [get_pins U0/Q] [get_pins U0/X]
create_generated_clock -name b -source [get_pins U0/D] -master_clock clk -divide_by 2 [get_pins U0/D] [get_pins U0/X]
create_generated_clock -name c -source [get_pins U0/X] -divide_by 2 [get_pins U0/X]`, '2026-09-21', ambiguousDesign);
    expect(result.clockGraph.diagnostics.map((item) => item.code)).toContain('AMBIGUOUS_CLOCK_SOURCE');
  });
});

describe('constraint merge semantics', () => {
  it('overrides same setup key without dropping the paired hold constraint', () => {
    const layers = [
      { id: 'base', content: `create_clock -name clk -period 10 [get_ports CLK]
set_multicycle_path 2 -setup -from [get_pins U0/Q] -to [get_pins U0/D]
set_multicycle_path 1 -hold -from [get_pins U0/Q] -to [get_pins U0/D]` },
      { id: 'project', content: 'set_multicycle_path 4 -setup -from [get_pins U0/Q] -to [get_pins U0/D]' }
    ];
    const result = mergeConstraints({ design, layers, asOf: '2026-09-21', ruleVersion: RULE_VERSION });
    const endpoints = analyzeEndpoints(design, result);
    expect(result.entries.filter((entry) => entry.kind === 'set_multicycle_path').map((entry) => entry.effective)).toEqual([false, true, true]);
    expect(endpoints[0].multicycle).toEqual({
      setup: { entryId: 'project:set_multicycle_path:1', pathCount: 4 },
      hold: { entryId: 'base:set_multicycle_path:3', pathCount: 1 }
    });
  });

  it('keeps fingerprints independent of edit collection iteration order', () => {
    const editsA = [
      { id: 'a', type: 'disable_exception', targetEntryId: 'x' },
      { id: 'b', type: 'disable_exception', targetEntryId: 'y' }
    ];
    const first = mergeConstraints({ design, layers: [{ id: 'L', content: 'create_clock -name clk -period 1 [get_ports CLK]' }], edits: editsA, asOf: '2026-09-21' });
    const second = mergeConstraints({ design, layers: [{ id: 'L', content: 'create_clock -name clk -period 1 [get_ports CLK]' }], edits: [...editsA].reverse(), asOf: '2026-09-21' });
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
  });

  it('reports empty and expected-count diagnostics', () => {
    const result = merge('set_input_delay 1 -clock clk [get_ports MISSING*] # @expect 1');
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['EMPTY_MATCH', 'EXPECTED_MATCH_COUNT_MISMATCH']));
  });

  it('does not treat different clock domains as the same I/O delay key', () => {
    const layers = [
      { id: 'base', content: 'create_clock -name clk -period 1 [get_ports CLK]\nset_input_delay 1 -clock clk [get_ports DIN\\[\\*\\]]' },
      { id: 'project', content: 'create_clock -name clk_alt -period 1 [get_ports CLK]\nset_input_delay 2 -clock clk_alt [get_ports DIN\\[\\*\\]]' }
    ];
    const result = mergeConstraints({ design, layers, asOf: '2026-09-21', ruleVersion: RULE_VERSION });
    expect(result.entries.filter((entry) => entry.kind === 'set_input_delay').map((entry) => entry.effective)).toEqual([true, true]);
  });
});
