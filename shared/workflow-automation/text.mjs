// Text helpers shared by workflow-automation skills: bounding untrusted strings and stripping terminal control characters.
// Source of truth: shared/workflow-automation/text.mjs — run `npm run sync` after editing.

// Strings that come from the server or from a published definition are untrusted and unbounded; this is the cap for
// short ones (names, messages, descriptions in run plans). Live action descriptions use the longer docs cap.
export const MAX_UNTRUSTED_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 300;

// `text` cut to `max` characters plus an ellipsis when longer. { count: true } appends how many characters were dropped.
// Non-strings are returned unchanged.
export function truncate(text, max = MAX_UNTRUSTED_CHARS, { count = false } = {}) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return `${text.slice(0, max)}…${count ? ` (+${text.length - max} chars)` : ''}`;
}

// C0 and C1 control characters except \n and \t (ESC, CSI 0x9b, BEL, CR, ...). Keeps escape sequences in untrusted text
// from being interpreted by a terminal.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const stripControlChars = (text) => String(text).replace(CONTROL_CHARS, '');
