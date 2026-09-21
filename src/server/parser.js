// 简化 SDC 子集解析器。语法见 README.md。
// 每条命令一行；支持 {…} 原样分组、[get_* …] 对象查询、"…" 引号与 \ 转义。

const KNOWN_COMMANDS = new Set([
  'create_clock',
  'create_generated_clock',
  'set_input_delay',
  'set_output_delay',
  'set_false_path',
  'set_multicycle_path',
]);

const OBJECT_QUERIES = new Set(['get_ports', 'get_pins', 'get_cells', 'get_clocks']);

export class SdcSyntaxError extends Error {
  constructor(message, lineNo, line) {
    super(`line ${lineNo}: ${message}`);
    this.name = 'SdcSyntaxError';
    this.lineNo = lineNo;
    this.line = line;
  }
}

// 将一行切分为 token。{…} 保留为一个 token（含花括号），[cmd …] 递归求值为对象集 token。
function tokenize(line, lineNo) {
  const tokens = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    if (ch === '#') break;
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '{') depth += 1;
        if (line[j] === '}') depth -= 1;
        j += 1;
      }
      if (depth !== 0) throw new SdcSyntaxError('未闭合的 {', lineNo, line);
      tokens.push({ kind: 'brace', text: line.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '[') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '[') depth += 1;
        if (line[j] === ']') depth -= 1;
        j += 1;
      }
      if (depth !== 0) throw new SdcSyntaxError('未闭合的 [', lineNo, line);
      tokens.push({ kind: 'query', text: line.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < n) { out += line[j + 1]; j += 2; continue; }
        out += line[j]; j += 1;
      }
      if (j >= n) throw new SdcSyntaxError('未闭合的引号', lineNo, line);
      tokens.push({ kind: 'word', text: out });
      i = j + 1;
      continue;
    }
    // 普通 word：到空白或 # 为止，\c 表示字面字符 c
    let j = i;
    let out = '';
    while (j < n && line[j] !== ' ' && line[j] !== '\t' && line[j] !== '#') {
      if (line[j] === '\\' && j + 1 < n) { out += '\\' + line[j + 1]; j += 2; continue; }
      out += line[j]; j += 1;
    }
    tokens.push({ kind: 'word', text: out });
    i = j;
  }
  return tokens;
}

// 展开 brace token 内容为空格分隔的模式列表（保留内部转义）。
function bracePatterns(token, lineNo, line) {
  const inner = token.text.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(/\s+/);
}

// 解析对象集 token：[get_ports {a b}] / [get_pins x] / 裸词（视为 get_clocks 名称）
function parseObjectSet(token, lineNo, line) {
  if (token.kind === 'query') {
    const inner = token.text.slice(1, -1).trim();
    const sub = tokenize(inner, lineNo);
    const cmd = sub[0]?.text;
    if (!OBJECT_QUERIES.has(cmd)) {
      throw new SdcSyntaxError(`不支持的对象查询 [${cmd} …]，仅支持 ${[...OBJECT_QUERIES].join('/')}`, lineNo, line);
    }
    const kind = cmd.replace('get_', '').replace(/s$/, ''); // ports->port …
    let patterns = [];
    for (const t of sub.slice(1)) {
      if (t.kind === 'brace') patterns = patterns.concat(bracePatterns(t, lineNo, line));
      else if (t.kind === 'word') patterns.push(t.text);
      else throw new SdcSyntaxError('对象查询中不允许嵌套 […]', lineNo, line);
    }
    if (patterns.length === 0) throw new SdcSyntaxError('对象查询为空', lineNo, line);
    return { kind, patterns };
  }
  if (token.kind === 'word') return { kind: 'clock', patterns: [token.text] };
  throw new SdcSyntaxError('此处需要对象集（[get_* …] 或名称）', lineNo, line);
}

function requireValue(flag, tokens, idx, lineNo, line) {
  if (idx + 1 >= tokens.length) throw new SdcSyntaxError(`${flag} 缺少参数`, lineNo, line);
  return tokens[idx + 1];
}

function parseNumber(text, flag, lineNo, line) {
  const v = Number(text);
  if (!Number.isFinite(v)) throw new SdcSyntaxError(`${flag} 需要数值，得到 "${text}"`, lineNo, line);
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseExpires(text, lineNo, line) {
  if (!DATE_RE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new SdcSyntaxError(`-expires 需要 YYYY-MM-DD 日期，得到 "${text}"`, lineNo, line);
  }
  return text;
}

// 解析单个命令行，返回条目 spec（不含 id/layer）。
export function parseCommand(line, lineNo) {
  const tokens = tokenize(line, lineNo);
  if (tokens.length === 0) return null;
  const cmd = tokens[0].text;
  if (!KNOWN_COMMANDS.has(cmd)) {
    throw new SdcSyntaxError(`不支持的命令 "${cmd}"，子集仅含 ${[...KNOWN_COMMANDS].join(', ')}`, lineNo, line);
  }
  const args = tokens.slice(1);

  if (cmd === 'create_clock') {
    const spec = { type: cmd, name: null, period: null, targets: null };
    for (let i = 0; i < args.length; i += 1) {
      const t = args[i];
      if (t.text === '-name') spec.name = requireValue('-name', args, i, lineNo, line).text, i += 1;
      else if (t.text === '-period') spec.period = parseNumber(requireValue('-period', args, i, lineNo, line).text, '-period', lineNo, line), i += 1;
      else if (t.kind === 'query' || t.kind === 'word') {
        if (spec.targets) throw new SdcSyntaxError('create_clock 只允许一个目标对象集', lineNo, line);
        spec.targets = parseObjectSet(t, lineNo, line);
      } else throw new SdcSyntaxError(`无法识别的参数 "${t.text}"`, lineNo, line);
    }
    if (!spec.name || spec.period == null || !spec.targets) {
      throw new SdcSyntaxError('create_clock 需要 -name、-period 与目标对象集', lineNo, line);
    }
    return spec;
  }

  if (cmd === 'create_generated_clock') {
    const spec = { type: cmd, name: null, source: null, transform: null, targets: null };
    for (let i = 0; i < args.length; i += 1) {
      const t = args[i];
      if (t.text === '-name') spec.name = requireValue('-name', args, i, lineNo, line).text, i += 1;
      else if (t.text === '-source') spec.source = parseObjectSet(requireValue('-source', args, i, lineNo, line), lineNo, line), i += 1;
      else if (t.text === '-divide_by') spec.transform = { op: 'divide_by', n: parseNumber(requireValue('-divide_by', args, i, lineNo, line).text, '-divide_by', lineNo, line) }, i += 1;
      else if (t.text === '-multiply_by') spec.transform = { op: 'multiply_by', n: parseNumber(requireValue('-multiply_by', args, i, lineNo, line).text, '-multiply_by', lineNo, line) }, i += 1;
      else if (t.kind === 'query' || t.kind === 'word') {
        if (spec.targets) throw new SdcSyntaxError('create_generated_clock 只允许一个目标对象集', lineNo, line);
        spec.targets = parseObjectSet(t, lineNo, line);
      } else throw new SdcSyntaxError(`无法识别的参数 "${t.text}"`, lineNo, line);
    }
    if (!spec.name || !spec.source || !spec.transform || !spec.targets) {
      throw new SdcSyntaxError('create_generated_clock 需要 -name、-source、-divide_by/-multiply_by 与目标对象集', lineNo, line);
    }
    return spec;
  }

  if (cmd === 'set_input_delay' || cmd === 'set_output_delay') {
    const spec = { type: cmd, clock: null, minmax: 'max', value: null, targets: null };
    for (let i = 0; i < args.length; i += 1) {
      const t = args[i];
      if (t.text === '-clock') spec.clock = requireValue('-clock', args, i, lineNo, line).text, i += 1;
      else if (t.text === '-max' || t.text === '-min') spec.minmax = t.text.slice(1);
      else if (t.kind === 'word' && spec.value == null && /^-?\d/.test(t.text)) spec.value = parseNumber(t.text, 'delay', lineNo, line);
      else if (t.kind === 'query' || t.kind === 'word') {
        if (spec.targets) throw new SdcSyntaxError(`${cmd} 只允许一个目标对象集`, lineNo, line);
        spec.targets = parseObjectSet(t, lineNo, line);
      } else throw new SdcSyntaxError(`无法识别的参数 "${t.text}"`, lineNo, line);
    }
    if (!spec.clock || spec.value == null || !spec.targets) {
      throw new SdcSyntaxError(`${cmd} 需要 -clock、数值与目标对象集`, lineNo, line);
    }
    return spec;
  }

  // set_false_path / set_multicycle_path
  const spec = { type: cmd, from: null, to: null, through: null, expiresOn: null, comment: null };
  if (cmd === 'set_multicycle_path') { spec.setup = null; spec.hold = null; }
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t.text === '-from') spec.from = parseObjectSet(requireValue('-from', args, i, lineNo, line), lineNo, line), i += 1;
    else if (t.text === '-to') spec.to = parseObjectSet(requireValue('-to', args, i, lineNo, line), lineNo, line), i += 1;
    else if (t.text === '-through') spec.through = parseObjectSet(requireValue('-through', args, i, lineNo, line), lineNo, line), i += 1;
    else if (t.text === '-expires') spec.expiresOn = parseExpires(requireValue('-expires', args, i, lineNo, line).text, lineNo, line), i += 1;
    else if (t.text === '-comment') spec.comment = requireValue('-comment', args, i, lineNo, line).text, i += 1;
    else if (cmd === 'set_multicycle_path' && t.text === '-setup') spec.setup = parseNumber(requireValue('-setup', args, i, lineNo, line).text, '-setup', lineNo, line), i += 1;
    else if (cmd === 'set_multicycle_path' && t.text === '-hold') spec.hold = parseNumber(requireValue('-hold', args, i, lineNo, line).text, '-hold', lineNo, line), i += 1;
    else throw new SdcSyntaxError(`无法识别的参数 "${t.text}"`, lineNo, line);
  }
  if (!spec.from && !spec.to) throw new SdcSyntaxError(`${cmd} 至少需要 -from 或 -to`, lineNo, line);
  if (cmd === 'set_multicycle_path' && spec.setup == null && spec.hold == null) {
    throw new SdcSyntaxError('set_multicycle_path 需要 -setup 和/或 -hold', lineNo, line);
  }
  return spec;
}

// 解析整层文本，返回 [{ lineNo, raw, spec }]。空行与注释行跳过。
export function parseLayer(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const spec = parseCommand(raw, idx + 1);
    if (spec) out.push({ lineNo: idx + 1, raw: raw.trim(), spec });
  }
  return out;
}
