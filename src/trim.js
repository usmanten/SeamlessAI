// Shrinks a conversation that is too big for a model, losing as little as
// possible. Old command and tool output goes first, then old file contents,
// then the oldest whole turns. System instructions, the latest user message
// and the most recent messages are never touched.

/** The last few messages are always kept exactly as sent. */
export const RECENT_MESSAGES = 6;
/** Pieces shorter than this aren't worth shortening. */
const MIN_CHARS = 1000;
/** How much of a shortened tool output is kept, so the model knows what it was. */
const KEEP_CHARS = 200;
const NOTE = 'to fit the model\'s context';

/**
 * Returns { body, report } where body's estimated size is at most `limit`
 * tokens, or null if that can't be done without cutting something that must
 * be kept. `estimate(body)` gives a body's size in tokens; the router passes
 * the same estimate it uses for limits, so "fits" means the same thing here.
 */
export function trimToFit(body, limit, estimate) {
  const before = estimate(body);
  if (before <= limit) return { body, report: null };

  const messages = structuredClone(body.messages);
  const report = { toolOutputs: 0, fileContents: 0, droppedMessages: 0, before, after: before };

  // Sizes are tracked per message so a long conversation isn't re-measured
  // after every change. The estimate counts the messages' JSON, so a
  // change of n characters there changes it by about n / 3 tokens.
  const sizes = messages.map((m) => JSON.stringify(m).length);
  let delta = 0; // characters added (+) or removed (-) so far
  const resize = (i) => {
    const n = JSON.stringify(messages[i]).length;
    delta += n - sizes[i];
    sizes[i] = n;
  };
  // One token of slack covers rounding; the real estimate is checked at the end.
  const fitsWith = (extra = 0) => before + Math.ceil((delta + extra) / 3) + 1 <= limit;

  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  const recentFrom = Math.max(0, messages.length - RECENT_MESSAGES);
  const editable = (i) => i < recentFrom && i !== lastUser && !isInstructions(messages[i]);

  // 1. Old command and tool output, oldest first.
  for (let i = 0; i < messages.length && !fitsWith(); i++) {
    const m = messages[i];
    if (!editable(i) || (m.role !== 'tool' && m.role !== 'function')) continue;
    const text = textOf(m.content);
    if (text.length < MIN_CHARS) continue;
    m.content = `[SeamlessAI removed this old tool output (${text.length} characters) ${NOTE}. It began: ${JSON.stringify(text.slice(0, KEEP_CHARS))}]`;
    report.toolOutputs++;
    resize(i);
  }

  // 2. Old file contents: code blocks pasted into messages, and file
  // contents a model wrote out through a tool call.
  for (let i = 0; i < messages.length && !fitsWith(); i++) {
    const m = messages[i];
    if (!editable(i) || m.role === 'tool' || m.role === 'function') continue;
    if (typeof m.content === 'string') m.content = shortenCodeBlocks(m.content, report);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) if (part?.type === 'text' && typeof part.text === 'string') part.text = shortenCodeBlocks(part.text, report);
    }
    for (const call of m.tool_calls || []) {
      const args = call.function?.arguments;
      if (typeof args !== 'string' || args.length < MIN_CHARS) continue;
      call.function.arguments = JSON.stringify({ seamless_note: `SeamlessAI removed these old arguments (${args.length} characters) ${NOTE}` });
      report.fileContents++;
    }
    resize(i);
  }

  // 3. The oldest whole turns (a user message and everything up to the next
  // one), so a tool call is never separated from its result. Turns that
  // reach into the recent messages or the latest request are kept.
  const keepFrom = turnStart(messages, lastUser === -1 ? recentFrom : Math.min(recentFrom, lastUser));
  const drop = new Set();
  let removed = 0; // characters in dropped messages, commas included
  for (let i = 0; i < keepFrom && !fitsWith(drop.size ? noteSize(drop.size) - removed : 0); ) {
    if (isInstructions(messages[i])) {
      i++;
      continue;
    }
    do {
      drop.add(i);
      removed += sizes[i] + 1;
      i++;
    } while (i < keepFrom && messages[i].role !== 'user' && !isInstructions(messages[i]));
  }

  let out = messages;
  if (drop.size) {
    out = messages.filter((_, i) => !drop.has(i));
    let at = 0;
    while (at < out.length && isInstructions(out[at])) at++;
    // A separate system message, so the instructions stay word for word.
    out.splice(at, 0, droppedNote(drop.size));
    report.droppedMessages = drop.size;
  }

  const trimmed = { ...body, messages: out };
  report.after = estimate(trimmed);
  return report.after <= limit ? { body: trimmed, report } : null;
}

/** One line for logs and the x-seamless-trimmed header (plain ASCII). */
export function describeTrim(report) {
  const parts = [];
  if (report.toolOutputs) parts.push(`${report.toolOutputs} old tool output${report.toolOutputs === 1 ? '' : 's'} shortened`);
  if (report.fileContents) parts.push(`${report.fileContents} old file content${report.fileContents === 1 ? '' : 's'} shortened`);
  if (report.droppedMessages) parts.push(`${report.droppedMessages} oldest message${report.droppedMessages === 1 ? '' : 's'} removed`);
  return `${parts.join(', ')} (~${report.before} -> ~${report.after} tokens)`;
}

function isInstructions(m) {
  return m.role === 'system' || m.role === 'developer';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return content == null ? '' : JSON.stringify(content);
}

function shortenCodeBlocks(text, report) {
  return text.replace(/```[^\n]*\n[\s\S]*?```/g, (block) => {
    if (block.length < MIN_CHARS) return block;
    report.fileContents++;
    const fence = block.slice(0, block.indexOf('\n'));
    return `${fence}\n[SeamlessAI removed ${block.length} characters of old file content ${NOTE}]\n\`\`\``;
  });
}

/** Moves back to the user message that starts the turn holding index i. */
function turnStart(messages, i) {
  while (i > 0 && messages[i]?.role !== 'user') i--;
  return Math.max(0, i);
}

function droppedNote(count) {
  return {
    role: 'system',
    content: `Note from SeamlessAI: the ${count} oldest message${count === 1 ? ' was' : 's were'} removed from this conversation ${NOTE}. Later messages may refer to things no longer shown.`,
  };
}

/** Characters the note adds to the messages' JSON, comma included. */
function noteSize(count) {
  return JSON.stringify(droppedNote(count)).length + 1;
}
