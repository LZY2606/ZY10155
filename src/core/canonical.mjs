import { createHash } from 'node:crypto';

export function stableSorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(stableSorted(Object.keys(value)).map((key) => [key, stableClone(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableClone(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

export function canonicalNames(bindings = [], key) {
  const entries = Array.isArray(bindings) ? bindings : [bindings];
  return stableSorted([
    ...new Set(entries.flatMap((binding) => binding.objectBindings?.[key]?.flatMap((match) => match.names) ?? []))
  ]).join('|');
}

export function scopeKey(entry) {
  if (entry.kind === 'create_clock' || entry.kind === 'create_generated_clock') {
    return `${entry.kind}:${entry.name}`;
  }
  if (entry.kind === 'set_input_delay' || entry.kind === 'set_output_delay') {
    const clockName = typeof entry.clock === 'string'
      ? entry.clock
      : entry.clock?.kind === 'literal'
        ? entry.clock.pattern
        : entry.clock?.patterns?.join(',') ?? '';
    return [entry.kind, clockName, entry.delayMode ?? 'max', canonicalNames(entry, 'targets')].join(':');
  }
  return [
    entry.kind,
    entry.kind === 'set_multicycle_path' ? entry.mode ?? 'setup' : '',
    canonicalNames(entry, 'from'),
    canonicalNames(entry, 'through'),
    canonicalNames(entry, 'to')
  ].join(':');
}
