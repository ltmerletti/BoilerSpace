import { ORIGIN } from '../lib/config.mjs';
import { sourcesFromSnapshot } from '../lib/service.mjs';

export const snapshot = () => ({ versions: { lp: '1.62', le: '1.96' }, errors: [],
  courses: [{ id: 101, name: 'TEST Physics', current: true }, { id: 202, name: 'TEST Computing', current: true }],
  data: [101, 202].map(courseId => ({ courseId,
    assignments: [{ id: 1, title: 'Practice problems', instructions: 'Upload orbit.txt before October 30.', url: `${ORIGIN}/d2l/assignment/${courseId}`, dueAt: '2026-10-30T20:00:00Z' }],
    quizzes: [], announcements: [], events: [],
    content: [{ id: 7, title: courseId === 101 ? 'Radiation lecture.pdf' : 'Memory lecture.pdf', modulePath: ['Week 1'], fileUrl: `/d2l/api/le/1.96/${courseId}/content/topics/7/file`, url: `${ORIGIN}/d2l/le/content/${courseId}/viewContent/7/View`, updatedAt: '2026-10-01' }],
  })),
});
export function seed(database) { const value = snapshot(); database.publish(value, sourcesFromSnapshot(value)); return value; }
export const noSemantics = { index: async () => {}, close() {}, search: async () => ({ method: 'fixture', results: [] }) };
export async function waitJob(database, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = database.job(id);
    if (!['queued', 'running'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture job did not finish');
}
