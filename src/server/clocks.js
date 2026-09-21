// 时钟派生图：master clock 与 generated clock 的跨层源引用解析。
// 规则：generated clock 的 -source 可引用任意层已生效的时钟（按名称或源引脚）。
// 源解析命中 0 个 -> 诊断 unknown-source；命中多个不可区分的时钟 -> 拒绝（ambiguous-source）；
// 派生关系成环 -> 拒绝（clock-cycle）。

export function buildClockGraph(clockEntries, resolveSet) {
  // clockEntries: [{ id, layerRank, name, period?, source?, transform?, targets, resolvedTargets }]
  const errors = [];
  const nodes = new Map(); // name -> node

  for (const e of clockEntries) {
    if (nodes.has(e.name)) {
      errors.push({ code: 'duplicate-clock', message: `时钟名 "${e.name}" 被重复定义`, entryIds: [nodes.get(e.name).id, e.id] });
      continue;
    }
    nodes.set(e.name, {
      id: e.id,
      name: e.name,
      generated: e.type === 'create_generated_clock',
      period: e.period ?? null,
      transform: e.transform ?? null,
      layerRank: e.layerRank,
      targets: e.resolvedTargets,
      sourceSpec: e.source ?? null,
      sourceName: null,
    });
  }

  // 解析每个 generated clock 的源
  for (const node of nodes.values()) {
    if (!node.generated) continue;
    const src = node.sourceSpec;
    let candidates = [];
    if (src.kind === 'clock') {
      candidates = src.patterns.flatMap((p) => {
        const re = globToRe(p);
        return [...nodes.keys()].filter((n) => re.test(n));
      });
    } else {
      // 按引脚/端口反查：时钟目标集合包含该对象的时钟
      const hits = resolveSet(src); // 排序后的对象名
      const hitSet = new Set(hits);
      candidates = [...nodes.values()]
        .filter((n) => n.targets.some((t) => hitSet.has(t)))
        .map((n) => n.name);
    }
    candidates = [...new Set(candidates)].sort();
    if (candidates.length === 0) {
      errors.push({ code: 'unknown-source', message: `generated clock "${node.name}" 的源未命中任何时钟`, entryIds: [node.id] });
    } else if (candidates.length > 1) {
      errors.push({
        code: 'ambiguous-source',
        message: `generated clock "${node.name}" 的源命中多个不可区分的时钟: ${candidates.join(', ')}`,
        entryIds: [node.id],
      });
    } else {
      node.sourceName = candidates[0];
    }
  }

  // 环检测（仅在无解析错误时进行，避免噪音）
  if (errors.length === 0) {
    const state = new Map(); // name -> 1 visiting | 2 done
    const stack = [];
    const visit = (name) => {
      state.set(name, 1);
      stack.push(name);
      const node = nodes.get(name);
      if (node.generated && node.sourceName) {
        const s = node.sourceName;
        if (state.get(s) === 1) {
          const cycle = [...stack.slice(stack.indexOf(s)), s];
          errors.push({ code: 'clock-cycle', message: `时钟派生成环: ${cycle.join(' -> ')}`, entryIds: cycle.map((c) => nodes.get(c).id) });
        } else if (!state.has(s)) visit(s);
      }
      stack.pop();
      state.set(name, 2);
    };
    for (const name of nodes.keys()) if (!state.has(name)) visit(name);
  }

  const edges = [...nodes.values()]
    .filter((n) => n.generated && n.sourceName)
    .map((n) => ({ from: n.sourceName, to: n.name, transform: n.transform }));

  return { nodes: [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name)), edges, errors };
}

function globToRe(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') { re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; }
    else if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`);
}
