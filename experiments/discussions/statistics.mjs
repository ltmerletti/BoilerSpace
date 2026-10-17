// Paired inference for source-labeled discussion retrieval experiments.
const z95 = 1.959963984540054;

export function wilson(successes, total) {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(successes) || successes < 0 || successes > total) {
    throw new Error('Wilson intervals require integer counts and a positive denominator.');
  }
  const p = successes / total, z2 = z95 * z95, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = z95 * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return { successes, total, estimate: p, low: Math.max(0, center - radius), high: Math.min(1, center + radius) };
}

export function exactMcNemar(candidateOnly, referenceOnly) {
  if (![candidateOnly, referenceOnly].every(n => Number.isInteger(n) && n >= 0)) throw new Error('Invalid discordant counts.');
  const n = candidateOnly + referenceOnly;
  if (!n) return { candidateOnly, referenceOnly, discordant: 0, p: 1 };
  // Two-sided exact binomial test conditional on the discordant pairs. Work in
  // log space so a large, balanced sample does not underflow at its first term.
  let term = -n * Math.LN2, sum = term;
  for (let i = 1; i <= Math.min(candidateOnly, referenceOnly); i++) {
    term += Math.log(n - i + 1) - Math.log(i);
    const maximum = Math.max(sum, term);
    sum = maximum + Math.log(Math.exp(sum - maximum) + Math.exp(term - maximum));
  }
  return { candidateOnly, referenceOnly, discordant: n, p: Math.min(1, 2 * Math.exp(sum)) };
}

export function evidenceGroups(cases, { topicClusters = false } = {}) {
  const parent = new Map();
  const find = key => {
    if (!parent.has(key)) parent.set(key, key);
    if (parent.get(key) !== key) parent.set(key, find(parent.get(key)));
    return parent.get(key);
  };
  const join = (a, b) => { const [x, y] = [find(a), find(b)].sort(); parent.set(y, x); };
  for (const item of cases) {
    if (!item.expected?.length) throw new Error(`No answer evidence for ${item.id}. Keep diagnostics separate.`);
    const keys = item.expected.map(e => `thread:${e.threadKey}`);
    for (const key of keys) join(keys[0], key);
    if (topicClusters && item.dependenceGroup) join(keys[0], `topic:${item.dependenceGroup}`);
  }
  return cases.map(item => find(`thread:${item.expected[0].threadKey}`));
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(sorted, p) {
  const index = (sorted.length - 1) * p, low = Math.floor(index), part = index - low;
  return sorted[low] * (1 - part) + sorted[Math.ceil(index)] * part;
}

export function pairedBootstrap(differences, groups, { replicates = 10000, seed = 20261016 } = {}) {
  if (!differences.length || differences.length !== groups.length || !differences.every(Number.isFinite)) throw new Error('Invalid paired bootstrap data.');
  if (!Number.isInteger(replicates) || replicates < 100) throw new Error('Use at least 100 bootstrap replicates.');
  const clusters = new Map();
  differences.forEach((value, i) => {
    if (!groups[i]) throw new Error('Missing bootstrap cluster.');
    const group = clusters.get(groups[i]) ?? { sum: 0, count: 0 };
    group.sum += value; group.count++; clusters.set(groups[i], group);
  });
  const values = [...clusters.values()], random = randomGenerator(seed), samples = [];
  for (let b = 0; b < replicates; b++) {
    let sum = 0, count = 0;
    for (let i = 0; i < values.length; i++) {
      const value = values[Math.floor(random() * values.length)];
      sum += value.sum; count += value.count;
    }
    samples.push(sum / count);
  }
  samples.sort((a, b) => a - b);
  return { estimate: differences.reduce((a, b) => a + b, 0) / differences.length,
    low: quantile(samples, 0.025), high: quantile(samples, 0.975), clusters: values.length, replicates, seed,
    method: 'paired percentile bootstrap; sample whole clusters, weight by their question counts' };
}

export function comparePaired(cases, candidateRows, referenceRows, { metric = 'allEvidenceInContext', ...bootstrapOptions } = {}) {
  const ids = new Set(cases.map(c => c.id));
  if (ids.size !== cases.length || !cases.length) throw new Error('Cases require unique IDs and a positive denominator.');
  const aligned = rows => {
    const map = new Map(rows.map(r => [r.id, r]));
    if (map.size !== rows.length || map.size !== ids.size || [...map.keys()].some(id => !ids.has(id))) throw new Error('Paired result IDs do not match cases.');
    return cases.map(c => { const value = map.get(c.id)?.[metric]; if (value !== 0 && value !== 1) throw new Error('Paired endpoint must be binary.'); return value; });
  };
  const a = aligned(candidateRows), b = aligned(referenceRows), differences = a.map((v, i) => v - b[i]);
  const threadGroups = evidenceGroups(cases), topicGroups = evidenceGroups(cases, { topicClusters: true });
  const discordance = exactMcNemar(differences.filter(d => d === 1).length, differences.filter(d => d === -1).length);
  return { metric, questions: cases.length, candidate: wilson(a.reduce((x, y) => x + y, 0), a.length),
    reference: wilson(b.reduce((x, y) => x + y, 0), b.length),
    difference: pairedBootstrap(differences, threadGroups, bootstrapOptions),
    sourceTopicSensitivity: pairedBootstrap(differences, topicGroups, bootstrapOptions),
    mcnemar: new Set(threadGroups).size === cases.length ? discordance : null,
    inferenceNote: 'Wilson and exact McNemar assume independent primary questions. Source/topic cluster bootstrap is a dependence sensitivity check. All intervals are conditional on this authored capture, not population guarantees.' };
}

export function holm(pValues) {
  if (!pValues.every(p => Number.isFinite(p) && p >= 0 && p <= 1)) throw new Error('Invalid p-values.');
  const sorted = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p), adjusted = [];
  let previous = 0;
  for (const [rank, { p, i }] of sorted.entries()) {
    previous = Math.min(1, Math.max(previous, p * (sorted.length - rank)));
    adjusted[i] = previous;
  }
  return adjusted;
}
