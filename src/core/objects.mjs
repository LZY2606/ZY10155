function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableSorted(values) {
  return [...values].sort(compareStrings);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitEscaped(path) {
  const segments = [];
  let current = '';
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] === '\\' && i + 1 < path.length) {
      current += path[i] + path[i + 1];
      i += 1;
    } else if (path[i] === '/') {
      segments.push(current);
      current = '';
    } else {
      current += path[i];
    }
  }
  segments.push(current);
  return segments;
}

function segmentToRegExp(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\' && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[i + 1]);
      i += 1;
    } else if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      let end = i + 1;
      if (pattern[end] === '!') end += 1;
      if (pattern[end] === ']') end += 1;
      while (end < pattern.length && pattern[end] !== ']') end += 1;
      if (end < pattern.length) {
        const body = pattern.slice(i + 1, end).replace('!', '^');
        source += `[${body}]`;
        i = end;
      } else {
        source += '\\[';
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

export function globMatches(pattern, name) {
  const patternSegments = splitEscaped(pattern);
  const nameSegments = splitEscaped(name);
  const regexps = [];
  for (const segment of patternSegments) {
    if (segment === '**') regexps.push({ any: true });
    else regexps.push({ any: false, regexp: segmentToRegExp(segment) });
  }

  let patternIndex = 0;
  let nameIndex = 0;
  while (patternIndex < regexps.length || nameIndex < nameSegments.length) {
    const matcher = regexps[patternIndex];
    if (matcher?.any) {
      const next = regexps[patternIndex + 1];
      if (!next) return true;
      let candidate = nameIndex;
      while (candidate < nameSegments.length) {
        if (!next.any && next.regexp.test(nameSegments[candidate])) {
          const restPattern = regexps.slice(patternIndex + 2);
          const restName = nameSegments.slice(candidate + 1);
          if (restPattern.length === 0 && restName.length === 0) return true;
          if (
            restPattern.length <= restName.length &&
            restPattern.every((item, offset) => item.any || item.regexp.test(restName[offset]))
          ) {
            return true;
          }
        }
        candidate += 1;
      }
      return false;
    }
    if (!matcher || nameIndex >= nameSegments.length) return false;
    if (!matcher.regexp.test(nameSegments[nameIndex])) return false;
    patternIndex += 1;
    nameIndex += 1;
  }
  return true;
}

export function hasWildcard(pattern) {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) {
      i += 1;
      continue;
    }
    if ('*?[]'.includes(pattern[i])) return true;
  }
  return false;
}

export function buildObjectIndex(design, clockNames = []) {
  const byType = new Map([
    ['port', stableSorted(design.ports ?? [])],
    ['cell', stableSorted(design.cells ?? [])],
    ['pin', stableSorted(design.pins ?? [])],
    ['clock', stableSorted(clockNames)]
  ]);
  const all = stableSorted([...byType.get('port'), ...byType.get('cell'), ...byType.get('pin'), ...byType.get('clock')]);
  byType.set('object', all);
  return {
    byType,
    paths: stableSorted([...(design.paths ?? []).map((path) => path.id)])
  };
}

const COMMAND_TYPES = {
  get_ports: 'port',
  get_cells: 'cell',
  get_pins: 'pin',
  get_clocks: 'clock',
  get_objects: 'object'
};

export function resolveReference(reference, objectIndex, line) {
  const diagnostics = [];
  if (!reference) {
    return { names: [], diagnostics: [{ severity: 'error', code: 'MISSING_REFERENCE', message: 'Missing object reference', line }] };
  }
  if (reference.kind === 'literal') {
    const names = objectIndex.byType.get('object').includes(reference.pattern) ? [reference.pattern] : [];
    if (!names.length) {
      diagnostics.push({ severity: 'error', code: 'EMPTY_MATCH', message: `No object named ${reference.pattern}`, line });
    }
    return { names, diagnostics, status: names.length ? 'single' : 'empty', wildcard: false };
  }

  const type = COMMAND_TYPES[reference.command];
  if (!type) {
    return {
      names: [],
      diagnostics: [{ severity: 'error', code: 'UNSUPPORTED_COLLECTION', message: `Unsupported collection ${reference.command}`, line }],
      status: 'empty',
      wildcard: false
    };
  }

  const candidates = type === 'object'
    ? objectIndex.byType.get('object')
    : objectIndex.byType.get(type);
  const names = stableSorted(new Set(reference.patterns.flatMap((pattern) => candidates.filter((name) => globMatches(pattern, name)))));
  const wildcard = reference.patterns.some(hasWildcard);
  let status = 'single';
  if (names.length === 0) {
    status = 'empty';
    diagnostics.push({ severity: 'error', code: 'EMPTY_MATCH', message: `${reference.command} matched no objects`, line });
  } else if (names.length > 1 && wildcard) {
    status = 'broad';
    diagnostics.push({
      severity: 'warning',
      code: 'BROAD_MATCH',
      message: `${reference.command} matched ${names.length} objects`,
      line,
      expected: null,
      actual: names.length
    });
  } else if (names.length === 1 && wildcard) {
    status = 'single';
    diagnostics.push({ severity: 'info', code: 'SINGLE_MATCH', message: `${reference.command} matched one object`, line, actual: 1 });
  }
  return { names, diagnostics, status, wildcard };
}

export function bindEntryObjects(entry, objectIndex) {
  const diagnostics = [];
  const bound = {};
  const bind = (name, references = []) => {
    bound[name] = references.map((reference) => {
      const result = resolveReference(reference, objectIndex, entry.line);
      diagnostics.push(...result.diagnostics);
      return {
        reference,
        names: result.names,
        status: result.status,
        wildcard: result.wildcard,
        expectedMatchCount: null
      };
    });
  };

  bind('targets', entry.targets);
  bind('sources', entry.sources);
  bind('from', entry.from);
  bind('to', entry.to);
  bind('through', entry.through);
  if (entry.clock?.kind === 'collection') {
    const result = resolveReference(entry.clock, objectIndex, entry.line);
    diagnostics.push(...result.diagnostics);
    bound.clock = [{ reference: entry.clock, names: result.names, status: result.status, wildcard: result.wildcard, expectedMatchCount: null }];
  }

  for (const group of Object.values(bound)) {
    for (const match of group) {
      match.expectedMatchCount = entry.expectedMatchCount;
      if (entry.expectedMatchCount !== null && match.names.length !== entry.expectedMatchCount) {
        diagnostics.push({
          severity: 'error',
          code: 'EXPECTED_MATCH_COUNT_MISMATCH',
          message: `Expected ${entry.expectedMatchCount} matches, got ${match.names.length}`,
          line: entry.line,
          expected: entry.expectedMatchCount,
          actual: match.names.length
        });
      }
    }
  }
  return { ...entry, objectBindings: bound, diagnostics };
}
