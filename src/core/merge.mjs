import { parseLayer } from './parser.mjs';
import { bindEntryObjects, buildObjectIndex } from './objects.mjs';
import { analyzeClockGraph } from './clock-graph.mjs';
import { canonicalNames, scopeKey, sha256, stableSorted } from './canonical.mjs';

export const RULE_VERSION = '1.0.0';

export function dateStatus(entry, asOf) {
  if (entry.effective && asOf < entry.effective) return 'future';
  if (entry.expires && asOf >= entry.expires) return 'expired';
  return 'active';
}

export function isEntryActive(entry, asOf) {
  return dateStatus(entry, asOf) === 'active' && !entry.disabled;
}

function hasErrors(entry) {
  return (entry.diagnostics ?? []).some((diagnostic) => diagnostic.severity === 'error');
}

function parsedEntries(layers) {
  const parsed = [];
  const diagnostics = [];
  for (const layer of layers) {
    const result = parseLayer(layer);
    parsed.push(...result.entries);
    for (const diagnostic of result.diagnostics) {
      diagnostics.push({ ...diagnostic, layerId: layer.id });
    }
  }
  return { entries: parsed, diagnostics };
}

export function applyEdits(entries, edits = []) {
  return entries.map((entry) => {
    let changed = { ...entry, objectBindings: entry.objectBindings ? structuredClone(entry.objectBindings) : undefined };
    for (const edit of edits) {
      if (edit.targetEntryId !== entry.id) continue;
      if (edit.type === 'disable_exception') {
        changed.disabled = true;
        changed.disabledByEditId = edit.id;
      }
      if (edit.type === 'change_pattern' && edit.field && edit.collectionIndex !== undefined) {
        const group = changed.objectBindings?.[edit.field]?.[edit.collectionIndex];
        if (group) {
          group.reference = {
            kind: 'collection',
            command: group.reference.command,
            patterns: [edit.pattern]
          };
          group.names = [];
          group.status = 'pending';
          group.wildcard = true;
          changed.patternEdited = true;
          changed.patternEditId = edit.id;
        }
      }
    }
    return changed;
  });
}

function rebind(entries, design) {
  const clockNames = entries
    .filter((entry) => entry.kind === 'create_clock' || entry.kind === 'create_generated_clock')
    .map((entry) => entry.name)
    .filter(Boolean);
  const objectIndex = buildObjectIndex(design, clockNames);
  const diagnostics = [];
  const boundEntries = entries.map((entry) => {
    if (!entry.objectBindings) {
      const bound = bindEntryObjects(entry, objectIndex);
      diagnostics.push(...bound.diagnostics);
      return bound;
    }
    const normalized = {
      ...entry,
      clock: entry.clock ?? entry.objectBindings.clock?.[0]?.reference,
      targets: entry.objectBindings.targets?.map((match) => match.reference),
      sources: entry.objectBindings.sources?.map((match) => match.reference),
      from: entry.objectBindings.from?.map((match) => match.reference),
      to: entry.objectBindings.to?.map((match) => match.reference),
      through: entry.objectBindings.through?.map((match) => match.reference)
    };
    const bound = bindEntryObjects(normalized, objectIndex);
    diagnostics.push(...bound.diagnostics);
    return {
      ...entry,
      clock: normalized.clock,
      period: entry.period,
      delay: entry.delay,
      pathCount: entry.pathCount,
      objectBindings: bound.objectBindings
    };
  });
  return { entries: boundEntries, diagnostics };
}

function mergeGroups(entries, asOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = scopeKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const effective = new Map();
  const records = [];

  for (const [key, groupEntries] of groups) {
    const ordered = stableSorted(groupEntries.map((entry) => entry.id))
      .map((id) => groupEntries.find((entry) => entry.id === id))
      .sort((left, right) => left.layerOrder - right.layerOrder || String(left.line).localeCompare(String(right.line)) || left.id.localeCompare(right.id));
    const candidates = ordered.filter((entry) => !hasErrors(entry) && isEntryActive(entry, asOf));
    const winner = candidates.at(-1) ?? null;
    for (const entry of ordered) {
      const isWinner = entry.id === winner?.id;
      const shadows = ordered
        .filter((older) => older.layerOrder < entry.layerOrder && scopeKey(older) === key && !hasErrors(older) && isEntryActive(older, asOf))
        .map((older) => older.id);
      if (isWinner && shadows.length) {
        for (const olderId of shadows) {
          records.push({
            severity: 'info',
            code: 'RULE_SHADOWED',
            message: `Older same-key constraint is shadowed by ${entry.id}`,
            line: entry.line,
            layerId: entry.layerId,
            shadowedEntryId: olderId,
            winningEntryId: entry.id,
            key
          });
        }
      }
      effective.set(entry.id, isWinner);
    }
  }
  return { effective, records, groups };
}

function multicyclePairs(entries, effective, asOf) {
  const pathScopes = new Map();
  for (const entry of entries.filter((item) => item.kind === 'set_multicycle_path')) {
    const pathKey = ['set_multicycle_path', canonicalNames(entry, 'from'), canonicalNames(entry, 'through'), canonicalNames(entry, 'to')].join(':');
    if (!pathScopes.has(pathKey)) pathScopes.set(pathKey, new Map());
    pathScopes.get(pathKey).set(entry.mode, entry);
  }
  const pairs = [];
  for (const [pathKey, byMode] of pathScopes) {
    const setup = byMode.get('setup');
    const hold = byMode.get('hold');
    const pair = {
      pathKey,
      setup: setup && effective.get(setup.id) ? setup : null,
      hold: hold && effective.get(hold.id) ? hold : null,
      from: canonicalNames(setup ?? hold ?? {}, 'from'),
      through: canonicalNames(setup ?? hold ?? {}, 'through'),
      to: canonicalNames(setup ?? hold ?? {}, 'to'),
      associations: []
    };
    if (setup && effective.get(setup.id) && hold && !effective.get(hold.id)) {
      pair.associations.push({ severity: 'warning', code: 'MULTICYCLE_HOLD_NOT_EFFECTIVE', message: 'Setup override retained an older/non-effective hold association', line: setup.line });
    }
    pairs.push(pair);
  }
  return stableSorted(pairs.map((pair) => pair.pathKey)).map((key) => pairs.find((pair) => pair.pathKey === key));
}

export function mergeConstraints({ design, layers, edits = [], asOf, ruleVersion = RULE_VERSION }) {
  const layerOrder = new Map(layers.map((layer, index) => [layer.id, index]));
  const parsed = parsedEntries(layers);
  const edited = applyEdits(parsed.entries, edits).map((entry) => ({ ...entry, layerOrder: layerOrder.get(entry.layerId) }));
  const rebound = rebind(edited, design);
  const entries = rebound.entries;
  const diagnostics = [...parsed.diagnostics, ...rebound.diagnostics];
  const clockGroups = mergeGroups(entries.filter((entry) => entry.kind === 'create_clock' || entry.kind === 'create_generated_clock'), asOf);
  const exceptionGroups = mergeGroups(entries.filter((entry) => entry.kind.startsWith('set_')), asOf);
  const effective = new Map([...clockGroups.effective, ...exceptionGroups.effective]);
  const mergeDiagnostics = [...clockGroups.records, ...exceptionGroups.records];

  const activeClocks = entries.filter((entry) => entry.kind === 'create_clock' && effective.get(entry.id));
  const activeGenerated = entries.filter((entry) => entry.kind === 'create_generated_clock' && effective.get(entry.id));
  const lineFor = new Map(activeGenerated.map((entry) => [entry.name, entry.line]));
  const clockGraph = analyzeClockGraph(activeClocks, activeGenerated, lineFor);
  for (const name of clockGraph.rejected) {
    for (const entry of activeGenerated) {
      if (entry.name === name) effective.set(entry.id, false);
    }
  }
  diagnostics.push(...clockGraph.diagnostics);

  let effectiveEntries = entries.filter((entry) => effective.get(entry.id));
  const multicycle = multicyclePairs(entries, effective, asOf);
  effectiveEntries = entries.filter((entry) => effective.get(entry.id));

  const inputFingerprint = sha256({
    ruleVersion,
    layers: layers.map((layer) => ({ id: layer.id, hash: sha256(layer.content) })),
    edits: stableSorted(edits.map((edit) => sha256(edit))),
    designHash: sha256(design)
  });

  return {
    ruleVersion,
    asOf,
    entries: entries.map((entry) => ({
      ...entry,
      dateStatus: dateStatus(entry, asOf),
      effective: effective.get(entry.id) === true,
      diagnostics: entry.diagnostics ?? []
    })),
    effectiveEntries,
    clockGraph,
    multicycle,
    diagnostics: stableSorted(diagnostics.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)),
    mergeDiagnostics,
    inputFingerprint
  };
}
