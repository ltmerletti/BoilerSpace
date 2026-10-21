// Run inside the real panel in Chrome and Firefox, with synthetic model traffic.
export async function checkChatRecovery() {
  const saved = { fetch: window.fetch, timeout: AbortSignal.timeout, setTimeout: window.setTimeout, sendMessage: chrome.runtime.sendMessage };
  const { chats } = await chrome.storage.local.get('chats');
  const results = [];
  const check = (name, pass) => results.push({ name, pass: Boolean(pass) });
  const wait = async read => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (read()) return;
      await new Promise(resolve => saved.setTimeout.call(window, resolve, 20));
    }
    throw new Error('Chat recovery check timed out.');
  };
  let mode, turn = 0, requests = 0, cancelled = 0, deadline;
  window.setTimeout = (callback, ms, ...args) => saved.setTimeout.call(window, callback, mode === 'idle' && ms > 50_000 ? 80 : ms, ...args);
  AbortSignal.timeout = ms => {
    if (mode !== 'deadline' || ms !== 180_000) return saved.timeout.call(AbortSignal, ms);
    deadline = new AbortController();
    return deadline.signal;
  };
  window.fetch = async (url, options) => {
    if (!String(url).includes('/api/chat/completions')) return saved.fetch.call(window, url, options);
    requests++;
    if (mode === 'http-error') return new Response('', { status: 503 });
    const encoder = new TextEncoder();
    const delta = ++turn === 1
      ? { tool_calls: [{ index: 0, id: 'recover', type: 'function', function: { name: 'list_upcoming', arguments: '{}' } }] }
      : { content: 'The next question works.' };
    return new Response(new ReadableStream({
      start(controller) {
        if (mode === 'silent' || mode === 'idle' || mode === 'deadline') return;
        controller.enqueue(encoder.encode(mode === 'stream-error'
          ? 'data: {"error":{"message":"Synthetic model failure"}}\n\n'
          : `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`));
        // Deliberately leave the connection open after DONE.
      },
      cancel() { cancelled++; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const start = async nextMode => {
    mode = nextMode;
    turn = 0;
    const before = requests;
    const input = document.querySelector('textarea[aria-label="Question"]');
    input.value = `Explain the saved course dates (${nextMode}).`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[aria-label="Send"]').click();
    await wait(() => requests > before);
  };
  const complete = async text => {
    await wait(() => !document.querySelector('button[aria-label="Stop"]') && document.querySelector('.message.assistant:last-child')?.textContent.includes(text));
  };
  const nextQuestion = async () => {
    await start('done');
    await complete('The next question works.');
  };
  try {
    await start('http-error');
    await complete('HTTP 503');
    await nextQuestion();
    check('a server failure does not block the next question', true);
    check('DONE completes the tool call and final answer without closing the connection', cancelled >= 2);

    await start('silent');
    document.querySelector('button[aria-label="Stop"]').click();
    await complete('Stopped.');
    await nextQuestion();
    check('Stop releases a silent stream and another question succeeds', true);

    await start('stream-error');
    await complete('Synthetic model failure');
    await nextQuestion();
    check('a streamed server error releases Ask for the next question', true);

    await start('idle');
    await complete('stopped responding');
    await nextQuestion();
    check('a silent response times out and the next question succeeds', true);

    await start('deadline');
    deadline.abort(new DOMException('Timed out', 'TimeoutError'));
    await complete('took too long');
    await nextQuestion();
    check('the total deadline releases Ask and the next question succeeds', true);

    let failSave = true;
    chrome.runtime.sendMessage = message => {
      if (failSave && message.type === 'boilerspace-data' && message.action === 'save-chats') {
        failSave = false;
        return Promise.resolve({ ok: false, error: 'Synthetic storage failure' });
      }
      return saved.sendMessage.call(chrome.runtime, message);
    };
    const input = document.querySelector('textarea[aria-label="Question"]');
    input.value = 'A question whose initial save fails.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[aria-label="Send"]').click();
    await complete('Synthetic storage failure');
    await nextQuestion();
    check('a failed initial chat save does not leave Ask permanently busy', true);
    return results;
  } finally {
    window.fetch = saved.fetch;
    window.setTimeout = saved.setTimeout;
    AbortSignal.timeout = saved.timeout;
    chrome.runtime.sendMessage = saved.sendMessage;
    await chrome.storage.local.set({ chats });
  }
}
