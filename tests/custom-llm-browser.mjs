// Exercises the actual Settings form and Ask in both packaged browser variants.
export async function checkCustomLlm({ modelOutput, pages, permissionMode = 'native' }) {
  const original = { fetch: window.fetch, request: chrome.permissions.request };
  const stored = await chrome.storage.local.get(null);
  const baseUrl = 'https://genai.rcac.purdue.edu/synthetic/v1';
  const secret = 'synthetic-custom-browser-key';
  const checks = [], requests = [], permissions = [];
  const check = (name, pass) => { if (!pass) throw new Error(name); checks.push({ name, pass: true }); };
  const wait = async read => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (await read()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const fields = [...document.querySelectorAll('.custom-api-form input')].map(input => ({ type: input.type, valid: input.validity.valid, message: input.validationMessage, empty: !input.value }));
    throw new Error(`Custom model browser check timed out after ${checks.at(-1)?.name ?? 'setup'}: ${document.querySelector('[role="alert"]')?.textContent ?? ''}; fields=${JSON.stringify(fields)}; form=${document.querySelector('.custom-api-form')?.innerText}`);
  };
  const submit = () => window.customLlmSubmit ? window.customLlmSubmit() : document.querySelector('.custom-api-form button[type="submit"]').click();
  const selectProvider = async provider => {
    const select = document.querySelector('select[aria-label="Model provider"]');
    select.value = provider;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(async () => (await chrome.storage.local.get('llmProvider')).llmProvider === provider && !!document.querySelector(provider === 'custom' ? '.custom-api-form' : '[data-focus-key="model"]'));
  };
  const fill = (label, value) => {
    const input = [...document.querySelectorAll('label.field')].find(node => node.firstChild.textContent === label)?.querySelector('input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.fetch = async (url, options) => {
    if (!String(url).startsWith(baseUrl)) return original.fetch.call(window, url, options);
    if (String(url).endsWith('/models')) return new Response('', { status: 404 });
    const body = JSON.parse(options.body);
    requests.push({ url, body, authorization: options.headers.Authorization, redirect: options.redirect, credentials: options.credentials });
    if (body.response_format) return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(modelOutput) } }] });
    if (!body.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: 'Course dates' } }] });
    const tool = body.messages.findLast(message => message.role === 'tool');
    const delta = tool
      ? { content: `Here is the saved assignment [${JSON.parse(tool.content).items[0].source}].` }
      : { tool_calls: [{ index: 0, id: 'custom-items', type: 'function', function: { name: 'list_items', arguments: '{}' } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const requestPermission = async permission => {
    permissions.push(permission);
    return permissionMode === 'pregranted' ? chrome.permissions.contains(permission) : original.request.call(chrome.permissions, permission);
  };
  chrome.permissions.request = requestPermission;
  try {
    document.querySelector('[data-view="settings"]').click();
    const details = document.querySelector('[data-disclosure="genai-details"]');
    details.open = true;
    await selectProvider('custom');
    fill('API base URL', baseUrl + '/chat/completions');
    fill('API key', secret);
    fill('Model ID', 'custom-browser-model');
    chrome.permissions.request = async () => false;
    await submit();
    await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('not allowed'));
    check('denying site access leaves the custom API unsaved', !(await chrome.storage.local.get('customLlm')).customLlm);
    chrome.permissions.request = requestPermission;
    await submit();
    await wait(async () => (await chrome.storage.local.get('customLlm')).customLlm?.model === 'custom-browser-model' && !document.querySelector('.custom-api-form button[type="submit"]')?.disabled);
    check('the API form saves URL, model and key through the real background lifecycle', (await chrome.storage.local.get('customLlm')).customLlm.baseUrl === baseUrl);
    check('saving requests only the configured API host', permissions.length === 1 && permissions[0].origins.join() === 'https://genai.rcac.purdue.edu/*');
    check('the saved secret is not repopulated into the password field', document.querySelector('.custom-api-form input[type="password"]').value === '');
    check('saving retains the API model ID in the Settings form', document.querySelector('.custom-api-form input[list="api-models"]').value === 'custom-browser-model');
    fill('API base URL', 'https://other.example/v1');
    await submit();
    await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('Enter an API key'));
    check('changing the API host cannot reuse the old saved secret', permissions.length === 1 && (await chrome.storage.local.get('customLlm')).customLlm.baseUrl === baseUrl);
    fill('API base URL', baseUrl);
    [...document.querySelectorAll('.custom-api-form button')].find(button => button.textContent === 'Load models').click();
    await wait(() => document.querySelector('.custom-api-form [role="status"]')?.textContent.includes('enter a model ID'));
    check('a missing model list leaves the manually entered model usable', true);

    document.querySelector('[data-view="ask"]').click();
    await wait(() => !!document.querySelector('textarea[aria-label="Question"]'));
    document.querySelector('button[aria-label="New chat"]').click();
    const input = document.querySelector('textarea[aria-label="Question"]');
    input.value = 'Which assignments are in my saved course material?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[aria-label="Send"]').click();
    await wait(async () => requests.filter(request => request.body.stream).length >= 2 && !document.querySelector('#pending') && document.querySelector('.message.assistant:last-child')?.textContent.includes('Here is the saved assignment') && (await chrome.storage.local.get('chats')).chats?.[0]?.messages.some(message => message.role === 'assistant' && message.citations?.length));
    check('Ask uses a custom streamed tool call and renders its source citation', !!document.querySelector('.message.assistant a[href]') && requests.filter(request => request.body.stream).length >= 2);
    check('requests use the custom path, model and secret without cookies or redirects', requests.every(request => request.url === `${baseUrl}/chat/completions` && request.body.model === 'custom-browser-model' && request.authorization === `Bearer ${secret}` && request.credentials === 'omit' && request.redirect === 'error' && request.body.store === false));
    check('course grades are excluded from custom provider prompts', !JSON.stringify(requests).includes('9 / 10'));

    const { readUploadedSyllabus } = await import('./lib/syllabus.js');
    await readUploadedSyllabus(stored.snapshot, 1600001, { fileName: 'Synthetic syllabus.txt', kind: 'text', pages }, { epoch: stored._dataEpoch ?? 'initial' });
    const facts = (await chrome.storage.local.get('syllabi')).syllabi[1600001];
    check('syllabus extraction uses JSON schema output through the custom API', facts.status === 'done' && requests.some(request => request.body.response_format?.json_schema?.name === 'syllabus'));
    const { getExportData } = await import('./lib/store.js');
    check('both saved model keys stay out of exported data', !JSON.stringify(await getExportData()).includes(secret) && !(await getExportData()).genai);

    document.querySelector('[data-view="settings"]').click();
    document.querySelector('[data-disclosure="genai-details"]').open = true;
    await selectProvider('purdue');
    check('switching back restores the saved Purdue connection', (await (await import('./lib/genai.js')).getConnection()).provider !== 'custom');
    await selectProvider('custom');
    check('switching providers preserves the custom model and secret', (await (await import('./lib/genai.js')).getConnection()).key === secret);
    [...document.querySelectorAll('.custom-api-form button')].find(button => button.textContent === 'Remove API connection').click();
    await wait(async () => !(await chrome.storage.local.get('customLlm')).customLlm);
    check('removing the API connection clears its secret without falling back to Purdue', !await (await import('./lib/genai.js')).getConnection());
    return checks;
  } finally {
    window.fetch = original.fetch;
    chrome.permissions.request = original.request;
    await chrome.storage.local.remove('customLlm');
    await chrome.storage.local.set({ ...stored, llmProvider: stored.llmProvider ?? 'purdue' });
  }
}
