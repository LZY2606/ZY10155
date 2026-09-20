const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateBoundary(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const [, year, month, day] = value.match(DATE_RE);
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

function joinContinuations(text) {
  const physical = String(text ?? '').split(/\r?\n/);
  const logical = [];
  let current = '';
  let firstLine = 1;
  for (let index = 0; index < physical.length; index += 1) {
    const line = physical[index];
    if (!current) firstLine = index + 1;
    const continued = /\\\s*$/.test(line);
    current += (current ? ' ' : '') + line.replace(/\\\s*$/, '');
    if (!continued) {
      logical.push({ text: current, firstLine, lastLine: index + 1 });
      current = '';
    }
  }
  if (current) logical.push({ text: current, firstLine, lastLine: physical.length });
  return logical;
}

function tokenize(text, line, diagnostics) {
  const tokens = [];
  let index = 0;
  let comment = '';

  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '#') {
      comment = text.slice(index + 1).trim();
      break;
    } else if (char === '"' || char === '{') {
      const close = char === '"' ? '"' : '}';
      let value = '';
      index += 1;
      let closed = false;
      while (index < text.length) {
        const current = text[index];
        if (current === '\\' && close === '"' && index + 1 < text.length) {
          value += text[index + 1];
          index += 2;
        } else if (current === close) {
          closed = true;
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      if (!closed) {
        diagnostics.push(makeDiagnostic('error', char === '"' ? 'UNTERMINATED_STRING' : 'UNTERMINATED_BRACE', 'Unterminated token', line));
      }
      tokens.push(value);
    } else if (char === '[') {
      let depth = 1;
      let inner = '';
      index += 1;
      while (index < text.length && depth > 0) {
        const current = text[index];
        if (current === '[') depth += 1;
        if (current === ']') depth -= 1;
        if (depth > 0) inner += current;
        index += 1;
      }
      if (depth !== 0) {
        diagnostics.push(makeDiagnostic('error', 'UNTERMINATED_COLLECTION', 'Unterminated collection expression', line));
        tokens.push(null);
      } else {
        const args = tokenize(inner, line, diagnostics);
        const commandName = args.shift();
        tokens.push({ type: 'collection', command: commandName, args });
      }
    } else {
      let value = '';
      while (index < text.length && !/[\s#\[\]{}"]/.test(text[index])) {
        if (text[index] === '\\' && index + 1 < text.length) {
          value += text[index] + text[index + 1];
          index += 2;
        } else {
          value += text[index];
          index += 1;
        }
      }
      if (text[index - 1] === '\\' && index < text.length) {
        value += text[index];
        index += 1;
        while (index < text.length && !/[\s#\[\]{}"]/.test(text[index])) {
          value += text[index];
          index += 1;
        }
      }
      tokens.push(value);
    }
  }
  Object.defineProperty(tokens, 'comment', { value: comment, enumerable: false, configurable: true });
  return tokens;
}

function makeDiagnostic(severity, code, message, line) {
  return { severity, code, message, line };
}

function metadataFromComment(comment, line, diagnostics) {
  const metadata = { effective: null, expires: null, expectedMatchCount: null, reason: null };
  if (!comment) return metadata;
  const effective = /@effective\s+(\S+)/.exec(comment);
  const expires = /@expires\s+(\S+)/.exec(comment);
  const expected = /@expect\s+(\d+)/.exec(comment);
  if (effective) {
    metadata.effective = parseDateBoundary(effective[1]);
    if (!metadata.effective) diagnostics.push(makeDiagnostic('error', 'INVALID_EFFECTIVE_DATE', 'Invalid @effective date', line));
  }
  if (expires) {
    metadata.expires = parseDateBoundary(expires[1]);
    if (!metadata.expires) diagnostics.push(makeDiagnostic('error', 'INVALID_EXPIRES_DATE', 'Invalid @expires date', line));
  }
  if (expected) metadata.expectedMatchCount = Number(expected[1]);
  metadata.reason = comment
    .replace(/@effective\s+\S+/g, '')
    .replace(/@expires\s+\S+/g, '')
    .replace(/@expect\s+\d+/g, '')
    .trim() || null;
  return metadata;
}

function asRef(value) {
  if (value?.type === 'collection') {
    return { kind: 'collection', command: value.command, patterns: value.args.filter((arg) => typeof arg === 'string') };
  }
  if (typeof value === 'string') return { kind: 'literal', pattern: value };
  return null;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finalizeEntry(command, line, data, diagnostics) {
  if (command === 'create_clock') {
    if (!Number.isFinite(data.period)) diagnostics.push(makeDiagnostic('error', 'MISSING_PERIOD', 'create_clock requires -period', line));
    if (!data.name) diagnostics.push(makeDiagnostic('error', 'MISSING_NAME', 'create_clock requires -name', line));
  }
  if (command === 'create_generated_clock') {
    if (!data.name) diagnostics.push(makeDiagnostic('error', 'MISSING_NAME', 'create_generated_clock requires -name', line));
    if (!data.sources.length) diagnostics.push(makeDiagnostic('error', 'MISSING_SOURCE', 'create_generated_clock requires -source', line));
    if (!Number.isFinite(data.divideBy) && !Number.isFinite(data.multiplyBy)) {
      diagnostics.push(makeDiagnostic('error', 'MISSING_DERIVATION', 'create_generated_clock requires -divide_by or -multiply_by', line));
    }
  }
  if (command === 'set_input_delay' || command === 'set_output_delay') {
    if (!Number.isFinite(data.delay)) diagnostics.push(makeDiagnostic('error', 'MISSING_DELAY', `${command} requires numeric delay`, line));
    if (!data.clock) diagnostics.push(makeDiagnostic('error', 'MISSING_CLOCK', `${command} requires -clock`, line));
    if (!data.targets.length) diagnostics.push(makeDiagnostic('error', 'MISSING_TARGETS', `${command} requires targets`, line));
  }
  if (command === 'set_multicycle_path' && !Number.isInteger(data.pathCount)) {
    diagnostics.push(makeDiagnostic('error', 'MISSING_PATH_COUNT', 'set_multicycle_path requires an integer path count', line));
  }
  return { kind: command, line, ...data };
}

function parseCreateClock(tokens, line, diagnostics) {
  const data = { name: null, period: null, targets: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-period') data.period = toNumber(tokens[++i]);
    else if (token === '-name') data.name = tokens[++i];
    else if (typeof token === 'string' && !token.startsWith('-') && !data.name) data.name = token;
    else if (asRef(token)) data.targets.push(asRef(token));
    else diagnostics.push(makeDiagnostic('warning', 'IGNORED_TOKEN', `Ignored token ${String(token)}`, line));
  }
  return finalizeEntry('create_clock', line, data, diagnostics);
}

function parseGeneratedClock(tokens, line, diagnostics) {
  const data = {
    name: null,
    sources: [],
    targets: [],
    masterClock: null,
    divideBy: null,
    multiplyBy: null
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-name') data.name = tokens[++i];
    else if (token === '-source') data.sources.push(asRef(tokens[++i]));
    else if (token === '-master_clock') data.masterClock = tokens[++i];
    else if (token === '-divide_by') data.divideBy = toNumber(tokens[++i]);
    else if (token === '-multiply_by') data.multiplyBy = toNumber(tokens[++i]);
    else if (typeof token === 'string' && !token.startsWith('-') && !data.name) data.name = token;
    else if (asRef(token)) data.targets.push(asRef(token));
    else diagnostics.push(makeDiagnostic('warning', 'IGNORED_TOKEN', `Ignored token ${String(token)}`, line));
  }
  return finalizeEntry('create_generated_clock', line, data, diagnostics);
}

function parseIoDelay(command, tokens, line, diagnostics) {
  const data = { delay: toNumber(tokens.shift()), clock: null, delayMode: 'max', targets: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-clock') data.clock = asRef(tokens[++i]);
    else if (token === '-max' || token === '-min') data.delayMode = token.slice(1);
    else if (token === '-rise' || token === '-fall') data.edge = token.slice(1);
    else if (asRef(token)) data.targets.push(asRef(token));
    else diagnostics.push(makeDiagnostic('warning', 'IGNORED_TOKEN', `Ignored token ${String(token)}`, line));
  }
  return finalizeEntry(command, line, data, diagnostics);
}

function parsePathException(command, tokens, line, diagnostics) {
  const data = command === 'set_multicycle_path'
    ? { pathCount: Number.isInteger(toNumber(tokens[0])) ? toNumber(tokens.shift()) : toNumber(tokens.shift()), mode: 'setup', from: [], to: [], through: [] }
    : { mode: 'setup', from: [], to: [], through: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-setup' || token === '-hold') data.mode = token.slice(1);
    else if (token === '-from') data.from.push(asRef(tokens[++i]));
    else if (token === '-to') data.to.push(asRef(tokens[++i]));
    else if (token === '-through') data.through.push(asRef(tokens[++i]));
    else diagnostics.push(makeDiagnostic('warning', 'IGNORED_TOKEN', `Ignored token ${String(token)}`, line));
  }
  return finalizeEntry(command, line, data, diagnostics);
}

export function parseLayer(layer) {
  const diagnostics = [];
  const entries = [];
  for (const logical of joinContinuations(layer.content)) {
    const line = logical.firstLine === logical.lastLine ? logical.firstLine : `${logical.firstLine}-${logical.lastLine}`;
    const tokens = tokenize(logical.text, line, diagnostics);
    const command = tokens.shift();
    if (!command) continue;
    if (typeof command !== 'string') {
      diagnostics.push(makeDiagnostic('error', 'UNEXPECTED_COLLECTION', 'A command name must precede a collection', line));
      continue;
    }

    const supported = new Set([
      'create_clock',
      'create_generated_clock',
      'set_input_delay',
      'set_output_delay',
      'set_false_path',
      'set_multicycle_path'
    ]);
    if (!supported.has(command)) {
      diagnostics.push(makeDiagnostic('warning', 'UNSUPPORTED_COMMAND', `Ignored ${command}`, line));
      continue;
    }

    let entry;
    if (command === 'create_clock') entry = parseCreateClock(tokens, line, diagnostics);
    else if (command === 'create_generated_clock') entry = parseGeneratedClock(tokens, line, diagnostics);
    else if (command === 'set_input_delay' || command === 'set_output_delay') entry = parseIoDelay(command, tokens, line, diagnostics);
    else entry = parsePathException(command, tokens, line, diagnostics);

    const metadata = metadataFromComment(tokens.comment, line, diagnostics);
    Object.assign(entry, metadata);
    entry.id = `${layer.id}:${command}:${line}`;
    entry.layerId = layer.id;
    entries.push(entry);
  }
  return { layerId: layer.id, entries, diagnostics };
}
