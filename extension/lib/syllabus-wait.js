// A loaded wrapper can precede its JavaScript-rendered document by several seconds.
// Only stable document content counts; a course navbar is useful for link discovery alone.
export async function waitForSyllabus(read, { phase, timeoutMs = phase === 'links' ? 30_000 : 45_000, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const started = now();
  let signature = null;
  let stableSince = started;
  while (now() - started < timeoutMs) {
    const shot = await read();
    if (shot) {
      const next = JSON.stringify([shot.hrefs, shot.text, shot.navReady, shot.contentReady]);
      if (next !== signature) {
        signature = next;
        stableSince = now();
      }
      if (phase === 'links' && shot.hrefs?.length) return shot;
      if (now() - started >= 12_000 && now() - stableSince >= 2_000) {
        if (phase === 'links' && shot.navReady) return shot;
        if (phase === 'page' && shot.contentReady && shot.text?.length >= 600) return shot;
      }
    }
    await wait(400);
  }
  throw new Error(phase === 'links' ? 'The course navigation did not finish loading. Try checking for a syllabus again.' : 'The syllabus document did not finish loading. Try reading it again.');
}
