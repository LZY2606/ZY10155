import { stableSorted } from './canonical.mjs';

function namesFor(entry, field) {
  return stableSorted([...new Set(entry.objectBindings?.[field]?.flatMap((match) => match.names) ?? [])]);
}

function clockName(entry) {
  if (!entry.clock) return null;
  if (typeof entry.clock === 'string') return entry.clock;
  if (entry.clock.kind === 'literal') return entry.clock.pattern;
  return entry.clock.patterns?.[0] ?? null;
}

function pathFrom(path) {
  return path.from ?? path.start ?? null;
}

function pathTo(path) {
  return path.to ?? path.end ?? null;
}

function exceptionApplies(entry, path) {
  const from = namesFor(entry, 'from');
  const to = namesFor(entry, 'to');
  const through = namesFor(entry, 'through');
  if (from.length && !from.includes(pathFrom(path))) return false;
  if (to.length && !to.includes(pathTo(path))) return false;
  if (through.length && !through.every((name) => (path.through ?? []).includes(name))) return false;
  return true;
}

function ioApplies(entry, path) {
  const targetNames = namesFor(entry, 'targets');
  if (entry.kind === 'set_input_delay') {
    return targetNames.includes(pathFrom(path)) && (!(path.launchClock ?? path.captureClock) || clockName(entry) === (path.launchClock ?? path.captureClock));
  }
  return targetNames.includes(pathTo(path)) && (!(path.captureClock ?? path.launchClock) || clockName(entry) === (path.captureClock ?? path.launchClock));
}

export function analyzeEndpoints(design, merged) {
  const endpoints = [];
  const effective = merged.effectiveEntries;
  for (const path of design.paths ?? []) {
    const falsePaths = effective.filter((entry) => entry.kind === 'set_false_path' && exceptionApplies(entry, path));
    const mcpEntries = effective.filter((entry) => entry.kind === 'set_multicycle_path' && exceptionApplies(entry, path));
    const ioDelays = effective.filter(
      (entry) => (entry.kind === 'set_input_delay' || entry.kind === 'set_output_delay') && ioApplies(entry, path)
    );
    const setupMcp = mcpEntries.find((entry) => entry.mode === 'setup');
    const holdMcp = mcpEntries.find((entry) => entry.mode === 'hold');
    let conclusion = 'timed';
    if (falsePaths.length) conclusion = 'false_path';
    else if (setupMcp || holdMcp) conclusion = 'multicycle';

    endpoints.push({
      id: path.id,
      from: pathFrom(path),
      to: pathTo(path),
      launchClock: path.launchClock ?? null,
      captureClock: path.captureClock ?? null,
      conclusion,
      trace: stableSorted([
        ...falsePaths.map((entry) => ({ entryId: entry.id, kind: entry.kind, effect: 'false_path', layerId: entry.layerId, line: entry.line })),
        ...mcpEntries.map((entry) => ({
          entryId: entry.id,
          kind: entry.kind,
          effect: `multicycle_${entry.mode}`,
          pathCount: entry.pathCount,
          layerId: entry.layerId,
          line: entry.line
        })),
        ...ioDelays.map((entry) => ({
          entryId: entry.id,
          kind: entry.kind,
          effect: 'io_delay',
          value: entry.delay,
          clock: clockName(entry),
          layerId: entry.layerId,
          line: entry.line
        }))
      ].map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)),
      multicycle: {
        setup: setupMcp ? { entryId: setupMcp.id, pathCount: setupMcp.pathCount } : null,
        hold: holdMcp ? { entryId: holdMcp.id, pathCount: holdMcp.pathCount } : null
      }
    });
  }
  return endpoints;
}

function signature(endpoint) {
  return JSON.stringify({
    conclusion: endpoint.conclusion,
    trace: endpoint.trace,
    multicycle: endpoint.multicycle
  });
}

export function changedEndpoints(before, after) {
  const afterById = new Map(after.map((endpoint) => [endpoint.id, endpoint]));
  const changes = [];
  for (const old of before) {
    const next = afterById.get(old.id);
    if (!next || signature(old) !== signature(next)) {
      changes.push({ endpointId: old.id, before: old, after: next ?? null });
    }
  }
  for (const endpoint of after) {
    if (!before.some((old) => old.id === endpoint.id)) {
      changes.push({ endpointId: endpoint.id, before: null, after: endpoint });
    }
  }
  return stableSorted(changes.map((change) => change.endpointId)).map((id) => changes.find((change) => change.endpointId === id));
}
