// Following is a user choice. Layout changes and our own scroll writes cannot resume it.
export function createChatScrollFollow() {
  let following = true;
  const bindings = new WeakMap();
  const atBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
  const pause = () => { following = false; };

  return {
    get following() { return following; },
    reset() { following = true; },
    pause,
    restore(el, top) {
      const binding = bindings.get(el);
      if (binding?.gesture) {
        if (top !== el.scrollTop) binding.gesture = null;
        else {
          // A token can change height during an ongoing keyboard or touch scroll.
          binding.gesture.height = el.scrollHeight;
          binding.gesture.client = el.clientHeight;
        }
      }
      el.scrollTop = top;
    },
    handlers() {
      const binding = { gesture: null, touchY: null };
      const begin = (el, direction) => {
        bindings.set(el, binding);
        binding.gesture = { direction, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
        if (direction < 0) pause();
        else if (direction > 0 && atBottom(el)) following = true;
      };
      const scroll = el => {
        if (el.isConnected === false) return;
        const gesture = binding.gesture;
        if (!gesture) {
          if (!atBottom(el)) pause();
          return;
        }
        if (gesture.height !== el.scrollHeight || gesture.client !== el.clientHeight) {
          binding.gesture = null;
          return;
        }
        if (el.scrollTop < gesture.top && gesture.direction <= 0) pause();
        if (el.scrollTop > gesture.top && gesture.direction >= 0 && atBottom(el)) following = true;
        gesture.top = el.scrollTop;
      };
      return {
        onwheel: event => { if (event.deltaY) begin(event.currentTarget, Math.sign(event.deltaY)); },
        ontouchstart: event => { binding.touchY = event.touches[0]?.clientY ?? null; },
        ontouchmove: event => {
          const y = event.touches[0]?.clientY;
          if (y !== undefined && binding.touchY !== null && y !== binding.touchY) begin(event.currentTarget, Math.sign(binding.touchY - y));
          binding.touchY = y ?? null;
        },
        onkeydown: event => {
          if (event.target.closest('input, textarea, select, [contenteditable]')) return;
          if (event.target.closest('summary') && ['Enter', ' '].includes(event.key)) {
            pause();
            binding.gesture = null;
          } else if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) begin(event.currentTarget, -1);
          else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) begin(event.currentTarget, 1);
        },
        onpointerdown: event => {
          if (event.target.closest('summary')) {
            pause();
            binding.gesture = null;
          } else if (event.target === event.currentTarget) begin(event.currentTarget, 0);
        },
        onclick: event => {
          if (event.target.closest('summary')) {
            pause();
            binding.gesture = null;
          }
        },
        onpointerup: event => { scroll(event.currentTarget); binding.gesture = null; },
        onpointercancel: () => { binding.gesture = null; },
        onscroll: event => scroll(event.currentTarget),
        onscrollend: () => { binding.gesture = null; },
      };
    },
  };
}
