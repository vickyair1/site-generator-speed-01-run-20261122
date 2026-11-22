// A fast, byte-exact drop-in for makefun-site 1.0.0.
//
// Original implementation, written from the kit's README.md and the reference
// program's stated rules. It returns, for every case input, exactly the output
// tree makefun-site 1.0.0's build returns, only faster:
//
//   - a fused single-pass Markdown renderer (lexing and rendering in one walk,
//     no token array, no per-line regex battery: dispatch on the first char);
//   - an inline scanner that copies plain runs whole and only stops at the
//     characters that can change the output;
//   - memoized slugs and long dates (the same titles and tags recur hundreds
//     of times per case);
//   - template rendering over a string-part array, with whole-template
//     memoization for templates whose values are constant for the case
//     (header, footer, site-only partials) and per-element memoization for
//     the card include rendered once per post instead of once per list that
//     shows it.
//
// Pure JavaScript, no dependencies, no WASM, no native code. Every cache
// lives inside one run() call: nothing is carried from one case to the next.

/** Per-run state, rebuilt by every run() call. */
let S = null;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  // Fast path: no "..", ".", or empty segment anywhere, so joining is exact.
  if (
    rel.indexOf('..') === -1 && rel.indexOf('./') === -1 && rel.indexOf('//') === -1 && rel !== '.' && !rel.endsWith('/.') &&
    dir.indexOf('.') === -1
  ) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
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

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ANY = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ESC_ANY.test(text) ? text.replace(ESC_RE, (c) => ESC[c]) : text;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  let out = S.dateCache.get(date);
  if (out === undefined) {
    out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    S.dateCache.set(date, out);
  }
  return out;
}

const ASCII_RE = /^[\x00-\x7F]*$/;
const TRAILING_DASHES = /-+$/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is
 * left. Pure-ASCII input normalizes to itself, so it takes a char-code loop.
 */
function slugify(text) {
  let out = S.slugCache.get(text);
  if (out !== undefined) return out;
  if (ASCII_RE.test(text)) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = 0;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === 0) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
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
  }
  out = out.slice(0, 64).replace(TRAILING_DASHES, '');
  if (out === '') out = 'untitled';
  S.slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace (counted, not collected). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
    else ws = c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const TAG_BAD = /["[\]]/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRAILING_WS = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
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

const DATE_ERROR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERROR };
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: DATE_ERROR };
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERROR };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || TAG_BAD.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The close is the first line that is exactly "---": "\n---\n" in the middle
  // or "\n---" at the very end.
  let closeIdx = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (closeIdx !== -1) bodyStart = closeIdx + 5;
  else if (text.endsWith('\n---')) {
    closeIdx = text.length - 4;
    bodyStart = text.length;
  } else return { error: 'the front matter is not closed' };
  const lines = text.slice(4, closeIdx).split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const n = i + 2; // line number, counted from 1 at the opening "---"
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${n} is not "key: value"` };
    const key = line.slice(0, colon);
    let ok = true;
    for (let k = 0; k < key.length; k++) {
      if (!isKeyChar(key.charCodeAt(k))) {
        ok = false;
        break;
      }
    }
    if (!ok) return { error: `line ${n} is not "key: value"` };
    let raw;
    if (line.length === colon + 1) raw = '';
    else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
    else return { error: `line ${n} is not "key: value"` };
    raw = raw.replace(TRAILING_WS, '');
    if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' && key !== 'layout' && key !== 'slug' && key !== 'summary') {
      return { error: `unknown key "${key}"` };
    }
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WS_RE = /\s/;

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. A native scan finds
 * the next character that can change the output; the plain run before it is
 * copied whole. Each call makes its own scan state, so recursion into
 * strong/emphasis/link spans is safe.
 */
function inline(s, link) {
  const re = /[\\`*\[&<>"']/g;
  let out = '';
  let i = 0;
  let plain = 0;
  const n = s.length;
  let m;
  while ((m = re.exec(s)) !== null) {
    const at = m.index;
    const c = m[0];
    if (c === '\\') {
      // Backslash: an escape only before an escapable character, else itself.
      if (at + 1 < n && ESCAPABLE.has(s[at + 1])) {
        if (plain < at) out += s.slice(plain, at);
        const nx = s[at + 1];
        out += nx === '>' ? '&gt;' : nx;
        i = at + 2;
        plain = i;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '`') {
      // A backtick opens a code span closed by the next backtick, with at
      // least one character between; a backtick with no closer is itself.
      const j = s.indexOf('`', at + 1);
      if (j > at + 1) {
        if (plain < at) out += s.slice(plain, at);
        out += `<code>${escapeHtml(s.slice(at + 1, j))}</code>`;
        i = j + 1;
        plain = i;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '*') {
      if (s[at + 1] === '*') {
        const j = findUnescaped(s, '**', at + 2);
        if (j > at + 2) {
          if (plain < at) out += s.slice(plain, at);
          out += `<strong>${inline(s.slice(at + 2, j), link)}</strong>`;
          i = j + 2;
          plain = i;
          re.lastIndex = i;
        } else {
          if (plain < at) out += s.slice(plain, at);
          out += '**';
          i = at + 2;
          plain = i;
          re.lastIndex = i;
        }
      } else {
        const j = findSingleStar(s, at + 1);
        if (j > at + 1) {
          if (plain < at) out += s.slice(plain, at);
          out += `<em>${inline(s.slice(at + 1, j), link)}</em>`;
          i = j + 1;
          plain = i;
          re.lastIndex = i;
        } else {
          if (plain < at) out += s.slice(plain, at);
          out += '*';
          i = at + 1;
          plain = i;
          re.lastIndex = i;
        }
      }
      continue;
    }
    if (c === '[') {
      // [text](target): the first ] not escaped closes the text, ( must
      // follow at once, and the next ) closes the target, which must not be
      // empty or hold whitespace. Else [ is itself.
      const k = findUnescaped(s, ']', at + 1);
      const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !WS_RE.test(target)) {
        if (plain < at) out += s.slice(plain, at);
        out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(at + 1, k), link)}</a>`;
        i = q + 1;
        plain = i;
        re.lastIndex = i;
      } else {
        if (plain < at) out += s.slice(plain, at);
        out += '[';
        i = at + 1;
        plain = i;
        re.lastIndex = i;
      }
      continue;
    }
    // One of & < > " ': the entity.
    if (plain < at) out += s.slice(plain, at);
    out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    i = at + 1;
    plain = i;
    re.lastIndex = i;
  }
  if (plain < n) out += s.slice(plain, n);
  return out;
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level,
 * id and its inline HTML) and its excerpt (the first paragraph's inline HTML,
 * or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // Fence: a line of three backticks and an optional language, then spaces
    // or tabs only; its body runs to a line of three backticks, or the end.
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        let inner = '';
        i++;
        while (i < n) {
          const l = lines[i];
          if (l.charCodeAt(0) === 96 && l.charCodeAt(1) === 96 && l.charCodeAt(2) === 96 && FENCE_CLOSE.test(l)) break;
          inner += `${escapeHtml(l)}\n`;
          i++;
        }
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
        continue;
      }
    }
    // Heading: 1 to 6 #, at least one space or tab, then text.
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inline(h.text, link);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    // Thematic break: --- or ***, then spaces or tabs only.
    if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
    }
    // Blockquote: the lines opening on >, each with the > and one space
    // after it dropped, then trimmed; the empty ones dropped.
    if (c0 === 62) {
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') qlines.push(t);
      }
      blocks.push(qlines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(qlines.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    // List: a bullet or ordered line, and each following line of the same
    // kind is another item; a line of two or more spaces then a non-space
    // continues the item. Any other line ends the list. No nesting.
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = c0 === 45 || c0 === 42 ? BULLET.exec(line) : null;
      const ordered = bullet === null ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const start = isOrdered ? Number(ordered[1]) : 1;
        const items = [];
        while (i < n) {
          const m = marker.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(isOrdered ? m[2] : m[1])]);
            i++;
          } else if (CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        let lis = '';
        for (const parts of items) lis += `<li>${inline(parts.join('\n'), link)}</li>\n`;
        blocks.push(`${open}\n${lis}</${tag}>`);
        continue;
      }
    }
    // Paragraph: any other line, and the lines after it up to a blank line,
    // a fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs (the empty string included). */
function isSpacesOnly(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
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
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isSpacesOnly(src.slice(lineStart, open)) && isSpacesOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
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
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The root names `nodes` read that no enclosing loop binds, following
 * includes; null when unknown (an include cycle, or one through a template
 * whose own roots are unknown). A template whose roots are all case-level
 * values (site, tags, recent) renders the same for every page of the case.
 */
function freeRootsOf(nodes, bound, visiting) {
  const free = new Set();
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      const a = freeRootsOf(n.then, bound, visiting);
      if (a === null) return null;
      for (const x of a) free.add(x);
      if (n.else !== null) {
        const b = freeRootsOf(n.else, bound, visiting);
        if (b === null) return null;
        for (const x of b) free.add(x);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      const a = freeRootsOf(n.body, inner, visiting);
      if (a === null) return null;
      for (const x of a) free.add(x);
    } else if (n.kind === 'include') {
      const t = S.templates.get(n.name);
      if (t === undefined) continue;
      if (visiting.has(n.name)) return null;
      visiting.add(n.name);
      const a = freeRootsOf(t.nodes, bound, visiting);
      visiting.delete(n.name);
      if (a === null) return null;
      for (const x of a) free.add(x);
    }
  }
  return free;
}

/** Whether every member of `set` is in `allowed`. */
function subsetOf(set, allowed) {
  for (const x of set) if (!allowed.includes(x)) return false;
  return true;
}

/**
 * Whether any enclosing loop binds a case-level name (site, tags, recent):
 * a template that only reads those names is not constant for the case while
 * such a loop shadows them, so its render must not be memoized.
 */
function shadowedCase(scope) {
  let s = scope;
  while (s !== null) {
    if (Object.hasOwn(s.vars, 'loop')) {
      if (Object.hasOwn(s.vars, 'site') || Object.hasOwn(s.vars, 'tags') || Object.hasOwn(s.vars, 'recent')) return true;
    }
    s = s.parent;
  }
  return false;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
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

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of string parts) in `scope`
 * ({ vars, parent }) at include depth `depth`.
 */
function renderNodes(nodes, scope, depth, out) {
  for (const n of nodes) {
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
        if (branch !== null) renderNodes(branch, scope, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // A loop whose whole body is one include of a template that reads
        // nothing but the element and the case-level values renders the same
        // string for the same element wherever it appears: render each
        // element once and reuse it (the card shown on the index and again
        // on its tag pages, the recent list on every page).
        if (n.body.length === 1 && n.body[0].kind === 'include' && depth < INCLUDE_DEPTH) {
          const t = S.templates.get(n.body[0].name);
          if (t !== undefined && t.freeRoots !== null && subsetOf(t.freeRoots, [n.name, 'site', 'tags', 'recent']) && !shadowedCase(scope)) {
            let byDepth = n.elemCache;
            if (byDepth === undefined) {
              byDepth = new Map();
              n.elemCache = byDepth;
            }
            let perEl = byDepth.get(depth + 1);
            if (perEl === undefined) {
              perEl = new Map();
              byDepth.set(depth + 1, perEl);
            }
            for (let k = 0; k < xs.length; k++) {
              const x = xs[k];
              let s = perEl.get(x);
              if (s === undefined) {
                const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
                const parts = [];
                renderNodes(t.nodes, { vars, parent: scope }, depth + 1, parts);
                s = parts.join('');
                perEl.set(x, s);
              }
              out.push(s);
            }
            break;
          }
        }
        for (let k = 0; k < xs.length; k++) {
          const x = xs[k];
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, depth, out);
        }
        break;
      }
      case 'include': {
        const t = S.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        // A template that reads only the case-level values renders the same
        // for every page: render it once per depth and reuse it.
        if (t.freeRoots !== null && subsetOf(t.freeRoots, ['site', 'tags', 'recent']) && !shadowedCase(scope)) {
          let s = t.constCache.get(depth);
          if (s === undefined) {
            const parts = [];
            renderNodes(t.nodes, scope, depth + 1, parts);
            s = parts.join('');
            t.constCache.set(depth, s);
          }
          out.push(s);
        } else {
          renderNodes(t.nodes, scope, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it (computed once per source and reused: the card a list shows is the card its page shows). */
function cardOf(s) {
  if (s.card !== undefined) return s.card;
  if (s.words === undefined) s.words = wordsOf(s.body);
  s.card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  return s.card;
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  S = { slugCache: new Map(), dateCache: new Map(), templates: new Map() };
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      S.templates.set(name, { name, nodes: parseTemplate(name, input.templates[name]), freeRoots: null, constCache: new Map() });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  for (const rec of S.templates.values()) rec.freeRoots = freeRootsOf(rec.nodes, new Set(), new Set([rec.name]));

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  //    a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      b.sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!S.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const LINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if ((target.indexOf(':') !== -1 && LINK_SCHEME.test(target)) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
      b.broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
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
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    const t = S.templates.get(name);
    if (t === undefined) return null;
    const parts = [];
    renderNodes(t.nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, parts);
    return parts.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) } });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pagesCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  return b.output;
}
