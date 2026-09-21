// 设计层次索引与确定性对象匹配。
// 匹配规则（README 有完整定义）：
//   *  匹配任意长度字符序列；? 匹配单个字符；\c 表示字面字符 c；其余字符（含 [ ] /）均为字面。
// 匹配结果按字典序排序，保证与集合迭代顺序无关。

export function loadDesignIndex(json) {
  const ports = [...json.ports].sort();
  const pins = [...json.pins].sort();
  const cells = [...json.cells].sort();
  return {
    port: ports,
    pin: pins,
    cell: cells,
    sets: { port: new Set(ports), pin: new Set(pins), cell: new Set(cells) },
  };
}

// 将通配模式编译为正则。\c 转义为字面 c；未转义的 * ? 为通配符。
export function compilePattern(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      if (i + 1 >= pattern.length) throw new Error(`模式 "${pattern}" 以孤立反斜杠结尾`);
      re += escapeRe(pattern[i + 1]);
      i += 1;
    } else if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += escapeRe(ch);
  }
  re += '$';
  return new RegExp(re);
}

function escapeRe(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 对单个 kind 的对象列表做匹配，返回排序后的命中数组。
export function matchPattern(index, kind, pattern) {
  const list = index[kind];
  if (!list) throw new Error(`未知对象类别 "${kind}"`);
  const re = compilePattern(pattern);
  return list.filter((name) => re.test(name));
}

// 解析一个对象集 {kind, patterns[]}，返回 { objects, perPattern }。
// clock 类别由调用方提供时钟名列表（见 merge.js）。
export function resolveObjectSet(index, set, clockNames = []) {
  const universe = set.kind === 'clock' ? [...clockNames].sort() : index[set.kind];
  const perPattern = [];
  const all = new Set();
  for (const pattern of set.patterns) {
    const re = compilePattern(pattern);
    const hits = universe.filter((name) => re.test(name));
    perPattern.push({ pattern, hits });
    for (const h of hits) all.add(h);
  }
  return { objects: [...all].sort(), perPattern };
}

// 诊断分类：empty(0) / single(1) / broad(> threshold) / ok
export function classifyMatch(count, broadThreshold) {
  if (count === 0) return 'empty';
  if (count === 1) return 'single';
  if (count > broadThreshold) return 'broad';
  return 'ok';
}
