const MESSAGE_CHARS = 12_000;
const REPLY_PREVIEW_CHARS = 300;
const REPLIES_PER_PAGE = 30;

function offset(value, name, length) {
  if (!Number.isSafeInteger(value) || value < 0 || value > length) throw new Error(`${name} must be an integer between 0 and ${length}.`);
  return value;
}

function messagePage(message, start, source, limit = MESSAGE_CHARS) {
  const text = message.text ?? '';
  const end = Math.min(start + limit, text.length);
  return {
    source, author_role: message.role, endorsed: message.endorsed === true,
    text: text.slice(start, end), offset: start, text_length: text.length,
    text_truncated: end < text.length, next_offset: end < text.length ? end : null,
  };
}

// Bound each tool result while keeping every saved message reachable by continuation.
export function readDiscussionPage(thread, args, citation) {
  const replies = thread.replies ?? [];
  if (args.reply_id !== undefined) {
    if (typeof args.reply_id !== 'string') throw new Error('reply_id must be a string from a previous read.');
    if (args.reply_offset !== undefined) throw new Error('Use reply_offset for the reply list, or reply_id for one reply.');
    const reply = replies.find((item) => item.id === args.reply_id);
    if (!reply) throw new Error('This reply is not in the saved thread. Read the reply list to find its reply_id.');
    return {
      reply_id: reply.id, posted_at: reply.createdAt,
      ...messagePage(reply, offset(args.offset ?? 0, 'offset', (reply.text ?? '').length), citation(`:reply:${reply.id}`, ` (${reply.role} reply)`)),
    };
  }
  const start = offset(args.offset ?? 0, 'offset', (thread.text ?? '').length);
  const replyStart = offset(args.reply_offset ?? 0, 'reply_offset', replies.length);
  if (start && replyStart) throw new Error('Continue either the post text with offset or the reply list with reply_offset.');
  const result = { saved_reply_count: replies.length };
  if (!replyStart) Object.assign(result, messagePage(thread, start, citation('')));
  if (!start) {
    const page = replies.slice(replyStart, replyStart + REPLIES_PER_PAGE);
    Object.assign(result, {
      reply_offset: replyStart,
      replies: page.map((reply) => ({
        reply_id: reply.id, posted_at: reply.createdAt,
        ...messagePage(reply, 0, citation(`:reply:${reply.id}`, ` (${reply.role} reply)`), REPLY_PREVIEW_CHARS),
      })),
      next_reply_offset: replyStart + page.length < replies.length ? replyStart + page.length : null,
    });
  }
  return result;
}
