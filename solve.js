// site-generator-speed-01-run-20261122: a fast drop-in for makefun-site 1.0.0.
// Original implementation of makefun-site's semantics (front matter, template
// dialect, Markdown subset, slug rule, report), written for speed: a run-slicing
// inline Markdown scanner, char-dispatch block lexer, memoized slug/date
// lookups, memoized static template fragments and per-post card renders.
// Pure JavaScript/TypeScript source only; no WebAssembly, native addon or
// prebuilt binary. Nothing is cached from one case to the next: every cache
// below is created fresh inside one run() call.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
function escapeHtml(text) {
  return ESCAPE_RE.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

// ---------------------------------------------------------------- text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SLUG_MAX = 64;

/**
 * The slug of `text`, exactly makefun-site's rule. ASCII inputs (the common
 * case: titles, tag names, headings) skip NFKD + the combining-mark regex:
 * ASCII is NFKD-stable and holds no combining marks. Results are memoized
 * per run: titles respell, tag names and headings repeat.
 */
function makeSlugify() {
  const cache = new Map();
  const nonAscii = /[^\x00-\x7F]/;
  function slugUnicode(text) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  function slugAscii(text) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  return function slugify(text) {
    let v = cache.get(text);
    if (v === undefined) {
      v = nonAscii.test(text) ? slugUnicode(text) : slugAscii(text);
      cache.set(text, v);
    }
    return v;
  };
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function makeLongDate() {
  const cache = new Map();
  return function longDate(date) {
    let v = cache.get(date);
    if (v === undefined) {
      const y = date.slice(0, 4);
      const m = Number(date.slice(5, 7));
      const d = Number(date.slice(8, 10));
      v = `${d} ${MONTHS[m - 1]} ${y}`;
      cache.set(date, v);
    }
    return v;
  };
}

/** Is code unit `c` JavaScript whitespace (the \s set)? */
function isSpaceCode(c) {
  if (c <= 32) return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
  if (c < 0xa0) return false;
  return (
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace (no allocation). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else {
      if (!inWord) n++;
      inWord = true;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. Identical errors to makefun-site.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const line0 = firstNl === -1 ? text : text.slice(0, firstNl);
  if (line0 !== '---') return { error: 'no front matter' };
  // Find the first line after the opening that is exactly '---'.
  let closeAt = -1; // index of the '\n' just before the closing '---'
  let closeEnd = -1; // index just past the closing '---'
  let p = text.indexOf('\n---', 3);
  while (p !== -1) {
    const after = p + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeAt = p;
      closeEnd = after;
      break;
    }
    p = text.indexOf('\n---', after);
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const fmRegion = text.slice(4, closeAt);
  const fmLines = fmRegion === '' ? [] : fmRegion.split('\n');
  const data = {};
  for (let r = 0; r < fmLines.length; r++) {
    const line = fmLines[r];
    const n = r + 2; // line number: opening '---' is line 1
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    // LINE: /^([a-z_]+):(?: (.*))?$/
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${n} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${n} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;

/** Block kinds, by a line's first character (dispatch, not 8 regexes a line). */
const BK_BLANK = 0, BK_FENCE = 1, BK_HEADING = 2, BK_HR = 3, BK_QUOTE = 4,
  BK_BULLET = 5, BK_ORDERED = 6, BK_PARA = 7;

function headingOf(line) {
  // /^(#{1,6})[ \t]+(.*?)[ \t]*$/ with non-empty text.
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let end = line.length;
  while (end > n && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  let start = n;
  while (start < end && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  if (start === end) return null;
  return { depth: n, text: line.slice(start, end) };
}

function isHr(line) {
  // /^(?:---|\*\*\*)[ \t]*$/
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  const mark = c0 === 45 ? '---' : '***';
  if (!line.startsWith(mark)) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function fenceLang(line) {
  // FENCE_OPEN: /^```([A-Za-z0-9_+-]*)[ \t]*$/
  if (!line.startsWith('```')) return null;
  const m = FENCE_OPEN_RE.exec(line);
  return m === null ? null : m[1];
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  return FENCE_CLOSE_RE.test(line);
}

function orderedOf(line) {
  // /^(\d{1,9})\. (.*)$/
  let n = 0;
  while (n < line.length && n < 9 && line.charCodeAt(n) >= 48 && line.charCodeAt(n) <= 57) n++;
  if (n === 0) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { start: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

function isContinued(line) {
  // /^ {2,}\S/
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isSpaceCode(line.charCodeAt(i));
}

function blockKind(line) {
  if (line === '') return BK_BLANK;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK_RE.test(line) ? BK_BLANK : BK_PARA;
  if (c === 96) return fenceLang(line) !== null ? BK_FENCE : BK_PARA;
  if (c === 35) return headingOf(line) !== null ? BK_HEADING : BK_PARA;
  if (c === 45 || c === 42) {
    if (isHr(line)) return BK_HR;
    if (line.charCodeAt(1) === 32) return BK_BULLET;
    return BK_PARA;
  }
  if (c === 62) return BK_QUOTE;
  if (c >= 48 && c <= 57) return orderedOf(line) !== null ? BK_ORDERED : BK_PARA;
  return BK_PARA;
}

function trimLine(line) {
  const first = line.charCodeAt(0);
  const last = line.charCodeAt(line.length - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return line;
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** `src`'s block tokens, in order. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kind = blockKind(line);
    if (kind === BK_BLANK) {
      i++;
      continue;
    }
    if (kind === BK_FENCE) {
      const lang = fenceLang(line);
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    if (kind === BK_HEADING) {
      const h = headingOf(line);
      tokens.push({ type: 'heading', depth: h.depth, text: h.text });
      i++;
      continue;
    }
    if (kind === BK_HR) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (kind === BK_QUOTE) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(l);
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      tokens.push({ type: 'blockquote', lines: kept });
      continue;
    }
    if (kind === BK_BULLET || kind === BK_ORDERED) {
      const isOrdered = kind === BK_ORDERED;
      const firstStart = isOrdered ? orderedOf(line).start : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        let m = null;
        if (isOrdered) {
          const o = orderedOf(l);
          if (o !== null) m = o.text;
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          m = l.slice(2);
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      let start = 1;
      if (isOrdered) start = firstStart;
      tokens.push({ type: 'list', ordered: isOrdered, start, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length) {
      const k = blockKind(lines[i]);
      if (k === BK_BLANK || k === BK_FENCE || k === BK_HEADING || k === BK_HR) break;
      body.push(trimLine(lines[i++]));
    }
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62;
}

/** The first index from `from` (before `end`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const w0 = what.charCodeAt(0);
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (before `end`, one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Is `s` free of ASCII whitespace? (a link target's test, /\\s/ on short ASCII targets). */
const WS_RE = /\s/;
function hasWhitespace(s) {
  return WS_RE.test(s);
}

const ESC1 = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * `s[a..b]` rendered inline into `out` (an array of strings); `env.link(target)`
 * is a link's href. A run-slicing scanner: plain runs are appended whole (they
 * hold no escapable character), work happens only at special characters, and
 * nested spans recurse on ranges, never on sliced copies.
 */
function inlineInto(s, a, b, env, out) {
  let i = a;
  while (i < b) {
    SPECIAL_RE.lastIndex = i;
    const mt = SPECIAL_RE.exec(s);
    const j = mt !== null && mt.index < b ? mt.index : b;
    if (j > i) out.push(s.slice(i, j));
    if (j >= b) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && isEscapableCode(s.charCodeAt(i + 1))) {
        const nc = s.charCodeAt(i + 1);
        out.push(ESC1[nc] ?? s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < b && k > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2, b);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s, i + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, b);
      if (k > i + 1) {
        out.push('<em>');
        inlineInto(s, i + 1, k, env, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 || mm >= b ? '' : s.slice(k + 2, mm);
      if (target !== '' && !hasWhitespace(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s, i + 1, k, env, out);
        out.push('</a>');
        i = mm + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // One of & < > " '
    out.push(ESC1[c]);
    i++;
  }
}

function inline(s, env) {
  const out = [];
  inlineInto(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt.
 * `slugify` is the run's memoized slug function.
 */
function renderMarkdown(src, env, slugify) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        const body = t.lines.length === 0 ? '' : `${escapeHtml(t.lines.join('\n'))}\n`;
        blocks.push(`<pre><code${cls}>${body}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        const parts = [open, '\n'];
        for (const item of t.items) {
          parts.push('<li>', inline(item, env), '</li>\n');
        }
        parts.push(`</${tag}>`);
        blocks.push(parts.join(''));
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * Each template's external dependencies: the first names it reads that no
 * enclosing for-loop binds, transitively through includes. A template whose
 * deps are only site/tags/recent reads nothing that varies between renders
 * of one case, so its render can be memoized per case.
 */
function computeDeps(templates) {
  const deps = new Map();
  for (const name of templates.keys()) deps.set(name, new Set());
  const collect = (nodes, bound, out) => {
    for (const n of nodes) {
      if (n.kind === 'text') continue;
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        collect(n.then, bound, out);
        if (n.else !== null) collect(n.else, bound, out);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        collect(n.body, b2, out);
      } else if (n.kind === 'include') {
        const dd = deps.get(n.name);
        if (dd !== undefined) for (const x of dd) if (!bound.has(x)) out.add(x);
      }
    }
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of templates) {
      const d = deps.get(name);
      const before = d.size;
      collect(nodes, new Set(), d);
      if (d.size > before) changed = true;
    }
  }
  return deps;
}

const ROOT_CONSTS = new Set(['site', 'tags', 'recent']);

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of strings) in `scope`.
 * `ctx` holds the parsed templates, their dep sets, and the per-case caches:
 * staticMemo (template+depth -> rendered string) and elemCache
 * (template -> element object -> {depth, html}) for single-include for-loops.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // Fast path: the body is one include of a template that reads only
        // the loop variable and the case's root constants. Then the include's
        // output depends on the element alone: render once per element.
        if (n.body.length === 1 && n.body[0].kind === 'include' && depth < INCLUDE_DEPTH) {
          const incName = n.body[0].name;
          const inc = ctx.templates.get(incName);
          const dep = inc !== undefined ? ctx.deps.get(incName) : undefined;
          if (inc !== undefined && dep !== undefined && [...dep].every((d) => d === n.name || ROOT_CONSTS.has(d))) {
            let cache = ctx.elemCache.get(incName);
            if (cache === undefined) {
              cache = new Map();
              ctx.elemCache.set(incName, cache);
            }
            for (let k = 0; k < xs.length; k++) {
              const x = xs[k];
              const hit = cache.get(x);
              if (hit !== undefined && hit.depth === depth + 1) {
                out.push(hit.html);
                continue;
              }
              const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
              const tmp = [];
              renderNodes(inc, { vars, parent: scope }, ctx, depth + 1, tmp);
              const html = tmp.join('');
              cache.set(x, { depth: depth + 1, html });
              out.push(html);
            }
            break;
          }
        }
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const dep = ctx.deps.get(n.name);
        if (dep !== undefined && [...dep].every((d) => ROOT_CONSTS.has(d))) {
          const key = `${n.name}:${depth + 1}`;
          let memo = ctx.staticMemo.get(key);
          if (memo === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            memo = tmp.join('');
            ctx.staticMemo.set(key, memo);
          }
          out.push(memo);
          break;
        }
        renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const slugify = makeSlugify();
  const longDate = makeLongDate();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const deps = computeDeps(templates);
  const ctx = { templates, deps, staticMemo: new Map(), elemCache: new Map() };
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, refusals, drafts.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const cardCache = new Map();
  const getCard = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = s.post ? cards.get(s) : cardOf(s);
      cardCache.set(s, c);
    }
    return c;
  };
  const pageOf = (s) => ({
    ...getCard(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootVars = { site, tags: allTags, recent };
  const rootScope = { vars: rootVars, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
