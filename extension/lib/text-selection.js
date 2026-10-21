// Change only the edited span so browser selection offsets in unchanged text survive.
export function patchText(node, text) {
  const previous = node.data;
  if (previous === text) return;
  let start = 0, end = 0;
  while (start < previous.length && start < text.length && previous[start] === text[start]) start++;
  while (end < previous.length - start && end < text.length - start && previous[previous.length - 1 - end] === text[text.length - 1 - end]) end++;
  node.replaceData(start, previous.length - start - end, text.slice(start, text.length - end));
}

// Redraws (including the transition from streaming to saved) may replace nodes.
// Bookmark text offsets within stable answer blocks, retaining selection direction.
export function rememberTextSelection(root) {
  const document = root.ownerDocument;
  const selection = document.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return () => {};
  if (document.activeElement?.matches('input, textarea, [contenteditable]')) return () => {};
  const endpoint = (node, offset) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    const block = element.closest('[data-selection-key], [data-step-key], [data-disclosure]');
    const container = block && root.contains(block) ? block : root;
    const range = document.createRange();
    range.setStart(container, 0);
    range.setEnd(node, offset);
    return {
      attribute: ['data-selection-key', 'data-step-key', 'data-disclosure'].find(attribute => container.hasAttribute(attribute)),
      key: container.dataset.selectionKey ?? container.dataset.stepKey ?? container.dataset.disclosure,
      prefix: range.toString(), node, offset,
    };
  };
  const anchor = endpoint(selection.anchorNode, selection.anchorOffset);
  const focus = endpoint(selection.focusNode, selection.focusOffset);
  return () => {
    if (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset && selection.focusNode === focus.node && selection.focusOffset === focus.offset) return;
    const locate = point => {
      const container = point.attribute ? [...root.querySelectorAll(`[${point.attribute}]`)].find(element => element.getAttribute(point.attribute) === point.key) : root;
      if (!container || !container.textContent.startsWith(point.prefix)) return null;
      let offset = point.prefix.length;
      const walker = document.createTreeWalker(container, 4 /* SHOW_TEXT */);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (offset <= node.length) return { node, offset };
        offset -= node.length;
      }
      return offset === 0 ? { node: container, offset: 0 } : null;
    };
    const start = locate(anchor), end = locate(focus);
    if (start && end) selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  };
}
