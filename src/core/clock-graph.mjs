import { stableSorted } from './objects.mjs';

function entryTargets(entry) {
  return stableSorted([...new Set(entry.objectBindings.targets?.flatMap((match) => match.names) ?? [])]);
}

export function analyzeClockGraph(clockEntries, generatedEntries, lineFor) {
  const diagnostics = [];
  const nodes = new Map();
  const edges = [];
  const targetOwners = new Map();

  function addNode(entry, kind) {
    nodes.set(entry.name, {
      name: entry.name,
      kind,
      layerId: entry.layerId,
      line: entry.line,
      period: entry.period ?? null,
      targets: entryTargets(entry),
      source: kind === 'generated' ? stableSorted(entry.objectBindings.sources.flatMap((match) => match.names)) : [],
      divideBy: entry.divideBy ?? null,
      multiplyBy: entry.multiplyBy ?? null
    });
  }

  for (const entry of clockEntries) addNode(entry, 'base');
  for (const entry of generatedEntries) addNode(entry, 'generated');

  for (const node of nodes.values()) {
    for (const target of node.targets) {
      if (!targetOwners.has(target)) targetOwners.set(target, []);
      targetOwners.get(target).push({ name: node.name, layerId: node.layerId, line: node.line });
    }
  }

  function candidatesForSource(source) {
    return stableSorted([...new Set(targetOwners.get(source)?.map((owner) => owner.name) ?? [])]);
  }

  const rejected = new Set();
  for (const entry of generatedEntries) {
    const sourceNames = entry.objectBindings.sources.flatMap((match) => match.names);
    let master = null;
    if (entry.masterClock) {
      master = entry.masterClock;
      if (!nodes.has(master)) {
        rejected.add(entry.name);
        diagnostics.push({
          severity: 'error',
          code: 'UNKNOWN_MASTER_CLOCK',
          message: `Generated clock ${entry.name} references unknown master ${master}`,
          line: entry.line
        });
      }
    } else {
      const candidates = stableSorted([...new Set(sourceNames.flatMap(candidatesForSource))]);
      if (candidates.length === 0) {
        rejected.add(entry.name);
        diagnostics.push({
          severity: 'error',
          code: 'UNRESOLVED_CLOCK_SOURCE',
          message: `Generated clock ${entry.name} source is not driven by a known clock`,
          line: entry.line
        });
      } else if (candidates.length > 1) {
        rejected.add(entry.name);
        diagnostics.push({
          severity: 'error',
          code: 'AMBIGUOUS_CLOCK_SOURCE',
          message: `Generated clock ${entry.name} source has indistinguishable clocks ${candidates.join(', ')}`,
          line: entry.line,
          candidates
        });
      } else {
        master = candidates[0];
      }
    }
    if (master) edges.push({ from: master, to: entry.name, layerId: entry.layerId, line: entry.line });
  }

  const adjacency = new Map([...nodes.keys()].map((name) => [name, []]));
  for (const edge of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) adjacency.get(edge.from).push(edge.to);
  }

  const state = new Map();
  const stack = [];
  function visit(name) {
    state.set(name, 'active');
    stack.push(name);
    for (const next of adjacency.get(name) ?? []) {
      if (state.get(next) === 'active') {
        const cycleStart = stack.indexOf(next);
        const cycle = [...stack.slice(cycleStart), next];
        diagnostics.push({
          severity: 'error',
          code: 'CLOCK_DERIVATION_CYCLE',
          message: `Clock derivation cycle: ${cycle.join(' -> ')}`,
          line: lineFor.get(next) ?? null,
          cycle
        });
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(name, 'done');
  }
  for (const name of stableSorted(nodes.keys())) if (!state.has(name)) visit(name);

  for (const diagnostic of diagnostics) {
    if (diagnostic.cycle) for (const name of diagnostic.cycle.slice(0, -1)) rejected.add(name);
  }

  const acceptedNodes = [...nodes.values()].filter((node) => !rejected.has(node.name));
  const acceptedNames = new Set(acceptedNodes.map((node) => node.name));

  const seenEdges = new Set();
  const uniqueEdges = [];
  for (const edge of edges) {
    if (!acceptedNames.has(edge.from) || !acceptedNames.has(edge.to)) continue;
    const key = `${edge.from}=>${edge.to}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      uniqueEdges.push(edge);
    }
  }
  return {
    nodes: acceptedNodes,
    edges: uniqueEdges,
    diagnostics,
    rejected: stableSorted(rejected)
  };
}
