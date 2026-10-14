// Compares two sync snapshots and lists what a student would want to know about.
// The first sync of a course produces nothing, so a new install is not a wall of "new" items.

const MAX_CHANGES = 200;

function indexCourse(courseData) {
  const map = new Map();
  for (const list of [courseData.assignments, courseData.quizzes]) {
    for (const item of list ?? []) map.set(`${item.kind}:${item.id}`, item);
  }
  return map;
}

export function diffSnapshots(previous, next, detectedAt = next.fetchedAt) {
  if (!previous) return [];
  const before = new Map(previous.data.map((d) => [d.courseId, d]));
  const changes = [];
  const push = (change) => changes.push({ detectedAt, ...change, id: `${change.type}:${change.courseId}:${change.itemKey}:${change.to ?? ''}` });

  for (const courseData of next.data) {
    const old = before.get(courseData.courseId);
    if (!old) continue;
    const oldItems = indexCourse(old);
    for (const [key, item] of indexCourse(courseData)) {
      const prior = oldItems.get(key);
      if (!prior) {
        if (!item.isHidden && item.isActive !== false) push({ type: 'new', courseId: item.courseId, itemKey: key, kind: item.kind, title: item.title, to: item.dueAt, url: item.url });
      } else if ((prior.dueAt ?? null) !== (item.dueAt ?? null)) {
        push({ type: 'due-changed', courseId: item.courseId, itemKey: key, kind: item.kind, title: item.title, from: prior.dueAt, to: item.dueAt, url: item.url });
      }
    }

    const oldAnnouncements = new Set(old.announcements.map((a) => a.id));
    for (const a of courseData.announcements) {
      if (!oldAnnouncements.has(a.id) && !a.isHidden) {
        push({ type: 'announcement', courseId: a.courseId, itemKey: `announcement:${a.id}`, kind: 'announcement', title: a.title, url: a.url });
      }
    }

    const oldContent = new Map(old.content.map((t) => [t.id, t]));
    for (const topic of courseData.content) {
      const prior = oldContent.get(topic.id);
      if (!prior && !topic.isHidden) {
        push({ type: 'new-file', courseId: topic.courseId, itemKey: `content:${topic.id}`, kind: 'content', title: topic.title, url: topic.url });
      } else if (prior && topic.updatedAt && prior.updatedAt && topic.updatedAt !== prior.updatedAt) {
        push({ type: 'file-updated', courseId: topic.courseId, itemKey: `content:${topic.id}`, kind: 'content', title: topic.title, to: topic.updatedAt, url: topic.url });
      }
    }
  }
  return changes;
}

export function mergeChanges(existing, incoming) {
  const seen = new Set(existing.map((c) => c.id));
  return [...incoming.filter((c) => !seen.has(c.id)), ...existing].slice(0, MAX_CHANGES);
}
