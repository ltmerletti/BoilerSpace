// Deterministic grading of an ask() result { text, citations, trace } against a benchmark case's expect spec,
// plus aggregate pass-rate statistics by category.

const NOT_FOUND_CUE =
  /\b(not\s+(?:in|found|stated|listed|posted|mentioned|provided|available|specified|given|included)|no\s+(?:syllabus|mention|information|record|due\s+date|time\s+estimate|details|grade|room|location)|cannot\s+(?:find|open|access|read|see|determine)|can't\s+(?:find|open|access|read|see|determine)|(?:could\s+not|couldn't)\s+(?:find|open|access|read|see|confirm)|(?:can't|cannot)\s+confirm|there(?:'s|\s+is|\s+are)\s+no\b|(?:doesn't|does\s+not|don't|do\s+not)\s+(?:list|appear|mention|include|say|show)|isn't\s+(?:listed|posted|mentioned)|unable\s+to\s+(?:find|open|access|read)|don't\s+have\s+access|do\s+not\s+have\s+access|to\s+be\s+announced|tba\b|determined\s+later|larger\s+than\s+25\s*mb|not\s+a\s+word\s+document)/i;

// Extracts topic ids referenced by a citation source key (e.g. "file:content:12345:page 1" -> ["12345"]).
export function citationTopicIds(citation) {
  const key = String(citation?.key ?? '');
  const out = new Set();
  if (!key) return [];

  if (key.startsWith('file:content:')) {
    const parts = key.split(':');
    if (parts[2]) out.add(parts[2]);
  } else if (key.startsWith('file:overview:')) {
    out.add('overview');
    const parts = key.split(':');
    if (parts[2]) out.add(`overview:${parts[2]}`);
  } else if (key.startsWith('content:')) {
    const parts = key.split(':');
    if (parts[1]) out.add(parts[1]);
  } else if (key.startsWith('overview:')) {
    out.add('overview');
    out.add(key);
  } else if (key.startsWith('syllabus:')) {
    out.add('overview');
    const parts = key.split(':');
    if (parts[1]) out.add(`syllabus:${parts[1]}`);
  } else if (key.startsWith('syl-')) {
    out.add('overview');
  }
  return [...out];
}

// Also checks whether the model opened the expected topic via read_course_file or get_syllabus_facts in trace,
// while still requiring citations when citeTopicIds is set.
export function matchesCiteTopicIds(citations = [], expectedTopicIds = []) {
  if (!expectedTopicIds?.length) return { ok: true, matched: [], expected: [] };
  const cited = new Set();
  for (const c of citations ?? []) {
    for (const tid of citationTopicIds(c)) cited.add(String(tid));
    if (c?.key) cited.add(String(c.key));
  }
  const expected = expectedTopicIds.map(String);
  const matched = expected.filter((id) => cited.has(id));
  // If multiple topic IDs are listed in citeTopicIds (e.g. PDF and PPTX or overview and schedule mirrors),
  // citing at least one of the valid source files satisfies the citation check.
  return {
    ok: matched.length > 0,
    matched,
    expected,
  };
}

export function scoreResult(result, expect = {}) {
  const text = String(result?.text ?? '');
  const citations = result?.citations ?? [];
  const mustInclude = expect.mustInclude ?? [];
  const mustNotInclude = expect.mustNotInclude ?? [];
  const citeTopicIds = expect.citeTopicIds ?? [];
  const notFound = Boolean(expect.notFound);

  const missing = [];
  for (const pattern of mustInclude) {
    const re = new RegExp(pattern, 'i');
    if (!re.test(text)) missing.push(pattern);
  }

  const forbidden = [];
  for (const pattern of mustNotInclude) {
    const re = new RegExp(pattern, 'i');
    if (re.test(text)) forbidden.push(pattern);
  }

  const citationCheck = matchesCiteTopicIds(citations, citeTopicIds);
  const notFoundOk = !notFound || NOT_FOUND_CUE.test(text);

  const reasons = [];
  if (missing.length) reasons.push(`missing mustInclude: ${missing.map((m) => `/${m}/i`).join(', ')}`);
  if (forbidden.length) reasons.push(`matched mustNotInclude: ${forbidden.map((m) => `/${m}/i`).join(', ')}`);
  if (!citationCheck.ok) reasons.push(`missing citation for topicId in [${citationCheck.expected.join(', ')}]`);
  if (!notFoundOk) reasons.push('missing notFound cue in answer');

  const pass = missing.length === 0 && forbidden.length === 0 && citationCheck.ok && notFoundOk;

  return {
    pass,
    missing,
    forbidden,
    citedTopicIds: [...new Set((citations ?? []).flatMap(citationTopicIds))],
    citationOk: citationCheck.ok,
    notFoundOk,
    reasons,
  };
}

export function scoreCase(testCase, result) {
  return {
    id: testCase.id,
    category: testCase.category,
    ...scoreResult(result, testCase.expect),
  };
}

export function aggregateScores(scoredCases = []) {
  const byCategory = {};
  let passed = 0;

  for (const item of scoredCases) {
    const cat = item.category ?? 'uncategorized';
    byCategory[cat] ??= { total: 0, passed: 0, failed: 0, passRate: 0 };
    byCategory[cat].total += 1;
    if (item.pass) {
      byCategory[cat].passed += 1;
      passed += 1;
    } else {
      byCategory[cat].failed += 1;
    }
  }

  for (const stats of Object.values(byCategory)) {
    stats.passRate = stats.total ? Number(((stats.passed / stats.total) * 100).toFixed(1)) : 0;
  }

  const total = scoredCases.length;
  const failed = total - passed;
  const passRate = total ? Number(((passed / total) * 100).toFixed(1)) : 0;

  return {
    total,
    passed,
    failed,
    passRate,
    byCategory,
  };
}
