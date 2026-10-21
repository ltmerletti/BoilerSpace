// Injected into a real extension panel in Chrome and Firefox. Model traffic is synthetic.
export function installSelectionStream() {
  const original = window.fetch;
  window.fetch = async (url, options) => {
    if (!String(url).includes('/api/chat/completions')) return original(url, options);
    const request = JSON.parse(options.body);
    if (!request.stream) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Text selection' } }] }), { headers: { 'content-type': 'application/json' } });
    const encoder = new TextEncoder();
    if (request.messages.at(-1).role !== 'tool') {
      const delta = { tool_calls: [{ index: 0, id: 'selection-courses', type: 'function', function: { name: 'list_courses', arguments: '{}' } }] };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(new ReadableStream({ start(controller) {
      const write = text => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      write('Select this explanation while it grows. ');
      window.writeSelectionChunk = write;
      window.finishSelectionStream = () => { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
}

// Coordinates for real mouse dragging, keeping the target on one rendered line.
export function selectionCoordinates() {
  const element = document.querySelector('#pending .streaming-answer p');
  element.scrollIntoView({ block: 'center' });
  const node = element.firstChild;
  const box = offset => {
    const range = document.createRange();
    range.setStart(node, offset); range.setEnd(node, offset + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 0.5, y: rect.top + rect.height / 2 };
  };
  return { start: box(0), end: box(11) };
}

export function selectionState() {
  const selection = getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  return { text: selection.toString(), backward: Boolean(range && selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset), top: document.querySelector('.messages').scrollTop };
}
