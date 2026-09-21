// 合并引擎：绑定对象集 -> 时钟图 -> 按公开覆盖规则合并 -> 计算每个 endpoint 的有效结论。
//
// 覆盖规则（README 完整定义）：
//   - 键 = 条目类型 + 规范化范围（解析后的对象名排序连接），与文件顺序无关；
//     不同类型的条目即使范围相同也不会共享键。
//   - 仅"存活"条目（未禁用、未过期）参与覆盖；层 rank 高者覆盖同键的低层条目。
//   - 同层同键：后出现的覆盖先出现的，并产生 duplicate-in-layer 诊断。
//   - 过期边界：expires_on 当天仍有效（as_of <= expires_on 为存活），次日零时起过期。
//   - multicycle 的 setup/hold 是一个原子条目：覆盖整体替换；只写 -setup 时
//     hold 按简化规则派生为 setup-1，绝不与旧条目的 hold 混搭。

import { createHash } from 'node:crypto';
import { resolveObjectSet, classifyMatch } from './design.js';
import { buildClockGraph } from './clocks.js';

export const RULES_VERSION = 1;

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHash(value) {
  return sha256(canonical(value));
}

// 解析条目内所有对象集，返回 { resolved, diagnostics }
function resolveEntry(entry, index, clockNames, broadThreshold) {
  const spec = entry.spec;
  const resolved = {};
  const diagnostics = [];
  const resolveOne = (clause, set) => {
    const r = resolveObjectSet(index, set, clockNames);
    resolved[clause] = r.objects;
    const cls = classifyMatch(r.objects.length, broadThreshold);
    if (cls === 'empty' || cls === 'broad') {
      diagnostics.push({
        code: cls === 'empty' ? 'empty-match' : 'broad-match',
        clause,
        count: r.objects.length,
        message: cls === 'empty'
          ? `${clause} 的对象集未命中任何${set.kind}`
          : `${clause} 的对象集命中 ${r.objects.length} 个对象，超过阈值 ${broadThreshold}`,
      });
    }
    resolved[`${clause}Class`] = cls;
  };
  if (spec.targets) resolveOne('targets', spec.targets);
  if (spec.from) resolveOne('from', spec.from);
  if (spec.to) resolveOne('to', spec.to);
  if (spec.through) resolveOne('through', spec.through);
  return { resolved, diagnostics };
}

// 条目覆盖键：类型 + 规范化范围。对象名排序，保证与集合迭代顺序无关。
function entryKey(type, resolved) {
  const seg = (names) => (names && names.length ? names.join(',') : '-');
  switch (type) {
    case 'create_clock':
    case 'create_generated_clock':
      return `${type}|targets=${seg(resolved.targets)}`;
    case 'set_input_delay':
    case 'set_output_delay':
      return `${type}|${resolved.minmaxScope}|targets=${seg(resolved.targets)}`;
    case 'set_false_path':
    case 'set_multicycle_path':
      return `${type}|from=${seg(resolved.from)}|to=${seg(resolved.to)}|through=${seg(resolved.through)}`;
    default:
      throw new Error(`未知条目类型 ${type}`);
  }
}

// 主入口：layers 按 rank 升序给出；asOf 为 YYYY-MM-DD。
export function mergeLayers({ layers, index, rules }) {
  const { broadMatchThreshold, asOf } = rules;
  const diagnostics = []; // 全局诊断
  const entries = []; // 解析后的扁平条目

  // 第一遍：收集时钟名（时钟对象集解析需要）
  const clockNames = [];
  for (const layer of layers) {
    for (const e of layer.entries) {
      if (e.spec.type === 'create_clock' || e.spec.type === 'create_generated_clock') clockNames.push(e.spec.name);
    }
  }

  // 第二遍：解析对象集
  for (const layer of layers) {
    for (const e of layer.entries) {
      const { resolved, diagnostics: diags } = resolveEntry(e, index, clockNames, broadMatchThreshold);
      if (e.spec.type === 'set_input_delay' || e.spec.type === 'set_output_delay') {
        resolved.minmaxScope = e.spec.minmax;
      }
      const entry = {
        id: e.id,
        layer: layer.name,
        layerRank: layer.rank,
        lineNo: e.lineNo,
        raw: e.raw,
        spec: e.spec,
        disabled: !!e.disabled,
        resolved,
        diagnostics: diags,
      };
      // multicycle hold 派生（原子关联，见文件头注释）
      if (entry.spec.type === 'set_multicycle_path' && entry.spec.hold == null && entry.spec.setup != null) {
        entry.derivedHold = entry.spec.setup - 1;
      }
      entries.push(entry);
      for (const d of diags) diagnostics.push({ ...d, entryId: e.id, layer: layer.name, lineNo: e.lineNo });
    }
  }

  // 时钟图（仅存活时钟条目参与）
  const liveClockEntries = entries.filter(
    (e) => (e.spec.type === 'create_clock' || e.spec.type === 'create_generated_clock') && !e.disabled,
  );
  const clockGraph = buildClockGraph(
    liveClockEntries.map((e) => ({
      id: e.id,
      layerRank: e.layerRank,
      type: e.spec.type,
      name: e.spec.name,
      period: e.spec.period,
      source: e.spec.source,
      transform: e.spec.transform,
      resolvedTargets: e.resolved.targets ?? [],
    })),
    (set) => resolveObjectSet(index, set, clockNames).objects,
  );
  for (const err of clockGraph.errors) diagnostics.push({ ...err, layer: null, lineNo: null });

  // 过期判定：as_of <= expires_on 为存活（到期日当天 24:00 前有效）
  for (const e of entries) {
    e.expired = !!e.spec.expiresOn && asOf > e.spec.expiresOn;
    if (e.expired) {
      diagnostics.push({
        code: 'expired', entryId: e.id, layer: e.layer, lineNo: e.lineNo,
        message: `例外已于 ${e.spec.expiresOn} 到期（as_of=${asOf}）`,
      });
    }
  }

  // 覆盖合并：仅存活条目参与；键 = 类型 + 规范化范围
  const live = entries.filter((e) => !e.disabled && !e.expired);
  const byKey = new Map();
  const shadowed = []; // { entryId, shadowedBy }
  const ordered = [...live].sort((a, b) => (a.layerRank - b.layerRank) || (a.lineNo - b.lineNo) || (a.id - b.id));
  for (const e of ordered) {
    const key = entryKey(e.spec.type, e.resolved);
    e.key = key;
    const prev = byKey.get(key);
    if (prev) {
      shadowed.push({ entryId: prev.id, shadowedBy: e.id });
      if (prev.layerRank === e.layerRank) {
        diagnostics.push({
          code: 'duplicate-in-layer', entryId: e.id, layer: e.layer, lineNo: e.lineNo,
          message: `同层重复键，后者覆盖前者（行 ${prev.lineNo}）`,
        });
      }
    }
    byKey.set(key, e);
  }
  for (const e of entries) {
    if (e.disabled) e.status = 'disabled';
    else if (e.expired) e.status = 'expired';
    else if (shadowed.some((s) => s.entryId === e.id)) e.status = 'shadowed';
    else e.status = 'effective';
  }
  const effective = [...byKey.values()];

  // endpoint 结论：endpoint = 任意存活条目 to/targets 覆盖的对象
  const endpointSet = new Set();
  for (const e of effective) {
    const objs = e.resolved.to ?? e.resolved.targets ?? [];
    for (const o of objs) endpointSet.add(o);
  }
  const conclusions = {};
  for (const ep of [...endpointSet].sort()) {
    const covering = effective
      .filter((e) => (e.resolved.to ?? e.resolved.targets ?? []).includes(ep))
      .map((e) => ({
        key: e.key,
        type: e.spec.type,
        layer: e.layer,
        params: entryParams(e),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    conclusions[ep] = covering;
  }

  const result = {
    asOf,
    rulesVersion: rules.rulesVersion,
    entries: entries.map((e) => ({
      id: e.id, layer: e.layer, lineNo: e.lineNo, key: e.key ?? null, status: e.status,
      derivedHold: e.derivedHold ?? null,
    })),
    shadowed,
    clocks: clockGraph,
    conclusions,
    diagnostics,
  };

  // 结果指纹：仅依赖规范化内容，与 Map/Set 迭代顺序无关
  result.resultFingerprint = canonicalHash({
    rulesVersion: rules.rulesVersion,
    asOf,
    entries: result.entries,
    conclusions,
    clockEdges: clockGraph.edges,
  });
  return result;
}

function entryParams(e) {
  const s = e.spec;
  switch (s.type) {
    case 'create_clock': return { name: s.name, period: s.period };
    case 'create_generated_clock': return { name: s.name, transform: s.transform, source: s.sourceName ?? undefined };
    case 'set_input_delay':
    case 'set_output_delay': return { clock: s.clock, minmax: s.minmax, value: s.value };
    case 'set_false_path': return { expiresOn: s.expiresOn ?? null };
    case 'set_multicycle_path': return { setup: s.setup ?? null, hold: s.hold ?? e.derivedHold ?? null, expiresOn: s.expiresOn ?? null };
    default: return {};
  }
}

// 计划指纹：幂等键 = 输入层（名称+内容哈希，按 rank 排序）+ 规则版本 + as_of
export function planFingerprint({ layers, rules }) {
  return canonicalHash({
    rulesVersion: rules.rulesVersion,
    asOf: rules.asOf,
    layers: layers.map((l) => ({ name: l.name, rank: l.rank, entries: l.entries.map((e) => ({ raw: e.raw, disabled: !!e.disabled })) })),
  });
}

// 两个结论集之间的 endpoint 级差异
export function diffConclusions(before, after) {
  const eps = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = [];
  for (const ep of eps) {
    const a = canonical(before[ep] ?? []);
    const b = canonical(after[ep] ?? []);
    if (a !== b) changed.push({ endpoint: ep, before: before[ep] ?? [], after: after[ep] ?? [] });
  }
  return changed;
}
