// Fast dependency-free Markdown renderer, byte-identical to marked 18.1.3
// with its default options (GFM on, breaks off, pedantic off, async off).
// Written from the CommonMark 0.31.2 + GFM 0.29 specs and from observing
// marked's behaviour on the spec examples (used only as an oracle).
// Architecture: a container-stack block parser over lines, plus a
// two-phase inline parser (tokenise with a link-opener stack, then a
// delimiter stack for emphasis / strikethrough).

// ---------- character helpers ----------
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
function isAsciiPunct(c) { return c !== undefined && ASCII_PUNCT.has(c); }
function isSpaceCh(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' ||
    c === '\u00a0' || c === '\u1680' || (c >= '\u2000' && c <= '\u200a') ||
    c === '\u2028' || c === '\u2029' || c === '\u202f' || c === '\u205f' || c === '\u3000';
}
const UNI_PUNCT = /[\p{P}\p{S}]/u;
function isUniPunct(c) { return c !== undefined && c !== '' && UNI_PUNCT.test(c); }
const UNI_ALNUM = /[\p{L}\p{N}]/u;
function isUniAlnum(c) { return c !== undefined && c !== '' && UNI_ALNUM.test(c); }
// A character counts as "preceded/followed by whitespace" at a string edge.
function isWsOrEdge(s, i) { return i < 0 || i >= s.length || isSpaceCh(s[i]); }
function isPunctOrEdge(s, i) { return i < 0 || i >= s.length ? false : isUniPunct(s[i]); }

// ---------- HTML escaping ----------
// Plain escape (used for code spans and plain text nodes).
function esc(s) {
  if (!s) return '';
  let out = '', i = 0, j;
  for (i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') { out += '&amp;'; }
    else if (c === '<') { out += '&lt;'; }
    else if (c === '>') { out += '&gt;'; }
    else if (c === '"') { out += '&quot;'; }
    else if (c === "'") { out += '&#39;'; }
    else out += c;
  }
  return out;
}

// ---------- entities ----------
// NAMED_ENT is a Set of valid HTML5 named-entity names (without the '&'
// and ';'), generated from the Python stdlib entity table. It is spliced
// into this file below the helpers (see the marker line near the end of
// the file). Valid named entities are passed through verbatim in output;
// valid numeric entities are decoded to the character (or U+FFFD).
function parseEntityAt(s, i) {
  // s[i] === '&'. Returns {kind:'named', name, len} | {kind:'num', ch, len} | null.
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < s.length && (hex ? isHexDigit(s[j]) : isDigit(s[j]))) j++;
    const digits = j - start;
    if (digits === 0 || s[j] !== ';') return null;
    if (!hex && digits > 7) return null;
    if (hex && digits > 6) return null;
    let code;
    if (hex) code = parseInt(s.slice(start, j), 16);
    else code = parseInt(s.slice(start, j), 10);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    return { kind: 'num', ch: String.fromCodePoint(code), len: j - i + 1 };
  }
  let j = i + 1;
  while (j < s.length && (isAlnumAscii(s[j]) || s[j] === '_')) j++;
  if (j === i + 1 || s[j] !== ';') return null;
  const name = s.slice(i + 1, j);
  return { kind: 'named', name, len: j - i + 1 };
}
function isDigit(c) { return c >= '0' && c <= '9'; }
function isHexDigit(c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
function isAlnumAscii(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
// Escape a string for an attribute value, but leave valid entity
// references (named or numeric) verbatim, as marked does for titles.
function escAttrEnt(s) {
  if (!s) return '';
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '&') {
      const e = parseEntityAt(s, i);
      if (e) { out += s.slice(i, i + e.len); i += e.len; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
    i++;
  }
  return out;
}
// href for a link/image: encodeURI, then attribute-escape with entities
// kept verbatim.
function hrefAttr(dest) {
  return escAttrEnt(encodeURI(dest).replace(/%25/g, '%'));
}

// Unescape backslash escapes (backslash + ASCII punctuation -> the char).
function unescapeStr(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// ---------- link labels, destinations, titles (shared by inline + ref defs) ----------
// Normalise a reference label: collapse whitespace runs to one space,
// trim, lowercase.
const CASE_FOLD = { '\u00df': 'ss', '\u1e9e': 'ss', '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st' };
function normalizeLabel(label) {
  let out = '', lastSpace = true;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      if (!lastSpace) { out += ' '; lastSpace = true; }
    } else { out += CASE_FOLD[c] || c.toLowerCase(); lastSpace = false; }
  }
  if (out.endsWith(' ')) out = out.slice(0, -1);
  return out;
}
// Parse a bracket label starting at s[i] === '['. Returns {label, end}
// (end = index just past ']') or null. Skips code spans and escaped chars.
function parseLabel(s, i) {
  if (s[i] !== '[') return null;
  let j = i + 1, depth = 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (c === '`') {
      let k = j, n = 0;
      while (k < s.length && s[k] === '`') { k++; n++; }
      // find a matching run of the same length
      let m = k;
      let found = -1;
      while (m < s.length) {
        if (s[m] === '`') {
          let e = m, nn = 0;
          while (e < s.length && s[e] === '`') { e++; nn++; }
          if (nn === n) { found = e; break; }
          m = e;
        } else m++;
      }
      if (found === -1) return null;
      j = found;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        const label = s.slice(i + 1, j);
        if (label.length === 0 || label.length > 999) return null;
        if (!/\S/.test(label)) return null;
        // a label may not contain an unescaped '[' at all (marked rejects
        // even balanced nested brackets, e.g. '[foo [bar] baz]')
        for (let q = 0; q < label.length; q++) {
          const ch = label[q];
          if (ch === '\\' && q + 1 < label.length && isAsciiPunct(label[q + 1])) { q++; continue; }
          if (ch === '[') return null;
        }
        return { label, end: j + 1 };
      }
    }
    j++;
  }
  return null;
}
// Parse a link destination starting at s[i] (after '(' or after ':' in a
// ref def, with leading spaces/newlines already skipped by the caller
// when appropriate). Returns {dest, next} or null.
function parseDest(s, i) {
  if (i >= s.length) return null;
  if (s[i] === '<') {
    let j = i + 1, out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: unescapeStr(out), next: j + 1 };
      if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  let j = i, depth = 0, out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') break;
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    out += c; j++;
  }
  if (j === i) return s[j] === ')' ? { dest: '', next: j } : null;
  return { dest: out, next: j };
}
// Parse a link title starting at s[i] (leading whitespace already skipped
// by the caller). Returns {title, next} or null.
function parseTitle(s, i) {
  if (i >= s.length) return null;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1, out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === q) return { title: unescapeStr(out), next: j + 1 };
      if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1, depth = 1, out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return { title: unescapeStr(out), next: j + 1 };
      }
      out += c; j++;
    }
    return null;
  }
  return null;
}
// Skip spaces/tabs/newlines from i; returns the new index.
function skipWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r' || s[i] === '\f' || s[i] === '\v')) i++;
  return i;
}
// Skip spaces/tabs only (no newlines).
function skipSpaces(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

// ---------- inline helpers: autolinks, raw HTML tags ----------
// Trim a bare autolink candidate the way GFM/marked do: drop a trailing
// named-entity-like reference, drop an unmatched or nested-group closing
// paren, drop trailing punctuation (?!.,:;*_~'").
function trimAutolink(s) {
  for (let guard = 0; guard < 8; guard++) {
    const m = /&[A-Za-z][A-Za-z0-9]*;$/.exec(s);
    if (m) { s = s.slice(0, m.index); continue; }
    if (s.endsWith(')')) {
      let open = 0, close = 0;
      for (let k = 0; k < s.length; k++) { if (s[k] === '(') open++; else if (s[k] === ')') close++; }
      if (close > open) { s = s.slice(0, -1); continue; }
      let depth = 0, matchIdx = -1;
      for (let k = s.length - 1; k >= 0; k--) {
        if (s[k] === ')') depth++;
        else if (s[k] === '(') { depth--; if (depth === 0) { matchIdx = k; break; } }
      }
      if (matchIdx >= 0 && s.slice(matchIdx + 1, s.length - 1).indexOf('(') !== -1) {
        s = s.slice(0, -1); continue;
      }
      break;
    }
    const last = s[s.length - 1];
    if (last !== undefined && '?!.,:;*_~\'"'.indexOf(last) !== -1) { s = s.slice(0, -1); continue; }
    break;
  }
  return s;
}
// Scan a URL tail starting at i: run of chars that are not whitespace,
// '<' or '>', stopping before a '(' whose group never closes.
function scanUrlTail(s, i) {
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c === '>') break;
    // a ']' followed by '(' or '[' closes link text: the URL ends here
    if (c === ']' && (s[j + 1] === '(' || s[j + 1] === '[')) break;
    if (c === '(') {
      // does this '(' close later in the run?
      let depth = 0, k = j, closed = false;
      while (k < s.length) {
        const d = s[k];
        if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === '<' || d === '>') break;
        if (d === '(') depth++;
        else if (d === ')') { depth--; if (depth === 0) { closed = true; break; } }
        k++;
      }
      if (!closed) break;
    }
    j++;
  }
  return j;
}
const LOCAL_CHARS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-".split(''));
function isLocalChar(c) { return c !== undefined && LOCAL_CHARS.has(c); }
const DOMAIN_CHARS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-'.split(''));
// Validate a bare-email domain (after trailing dots are trimmed):
// labels of [A-Za-z0-9_-]+, at least one dot, last char alnum.
function validEmailDomain(d) {
  if (d.length === 0 || d.indexOf('.') === -1) return false;
  if (!isAlnumAscii(d[d.length - 1])) return false;
  const labels = d.split('.');
  for (const lab of labels) {
    if (lab.length === 0) return false;
    for (let k = 0; k < lab.length; k++) {
      const c = lab[k];
      if (!isAlnumAscii(c) && c !== '-' && c !== '_') return false;
    }
  }
  return true;
}
// Parse a bare email starting at i (local part starts at i). Returns
// {text, end} (text = local@domain, end = index past it) or null.
function parseBareEmail(s, i, allowTrailingUnderscore) {
  let j = i;
  while (j < s.length && isLocalChar(s[j])) j++;
  if (j === i || s[j] !== '@') return null;
  const local = s.slice(i, j);
  let k = j + 1;
  while (k < s.length && DOMAIN_CHARS.has(s[k])) k++;
  let domain = s.slice(j + 1, k);
  while (domain.endsWith('.')) domain = domain.slice(0, -1);
  // a trailing '__' is the closing strong delimiter when an opening
  // '__' is already open: strip it so the email still resolves
  if (!validEmailDomain(domain) && allowTrailingUnderscore) {
    while (domain.endsWith('_')) domain = domain.slice(0, -1);
  }
  if (!validEmailDomain(domain)) return null;
  const end = j + 1 + domain.length;
  return { text: local + '@' + domain, end };
}
// Parse a www. autolink starting at i (s starts with 'www.' there).
// Returns {text, end} or null.
function parseWww(s, i) {
  let j = i + 4;
  const dstart = j;
  while (j < s.length) {
    const c = s[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '.') j++;
    else break;
  }
  if (j === dstart) return null;
  let domain = s.slice(dstart, j);
  while (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (domain.length === 0) return null;
  // labels must be non-empty, separated by single dots
  const labels = domain.split('.');
  for (const lab of labels) {
    if (lab.length === 0) return null;
    for (let k = 0; k < lab.length; k++) {
      const c = lab[k];
      if (!isAlnumAscii(c) && c !== '-') return null;
    }
  }
  const tailEnd = scanUrlTail(s, j);
  let text = trimAutolink(s.slice(i, tailEnd));
  if (text.length <= 4) return null;
  return { text, end: i + text.length };
}
// Parse a scheme:// autolink (http/https/ftp/file, any case) at i.
// Returns {text, end} or null.
function parseSchemeSlash(s, i) {
  const low = s.slice(i, i + 8).toLowerCase();
  let plen = 0;
  if (low.startsWith('http://')) plen = 7;
  else if (low.startsWith('https://')) plen = 8;
  else if (low.startsWith('ftp://')) plen = 6;
  else if (low.startsWith('file://')) plen = 7;
  else return null;
  const tailEnd = scanUrlTail(s, i + plen);
  if (tailEnd <= i + plen) return null;
  const text = trimAutolink(s.slice(i, tailEnd));
  if (text.length <= plen) return null;
  return { text, end: i + text.length };
}
// Parse a scheme:email autolink for mailto:/xmpp: at i.
// Returns {text, end} or null.
function parseSchemeEmail(s, i) {
  const low = s.slice(i, i + 7).toLowerCase();
  let scheme = null;
  if (low.startsWith('mailto:')) scheme = 'mailto';
  else if (low.startsWith('xmpp:')) scheme = 'xmpp';
  else return null;
  const estart = i + scheme.length + 1;
  const em = parseBareEmail(s, estart);
  if (!em) return null;
  let end = em.end;
  let text = s.slice(i, end);
  if (scheme === 'xmpp' && s[end] === '/') {
    // one path segment (no '/')
    let k = end + 1;
    while (k < s.length) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c === '>' || c === '/') break;
      if (c === '(') {
        let depth = 0, m = k, closed = false;
        while (m < s.length) {
          const d = s[m];
          if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === '<' || d === '>' || d === '/') break;
          if (d === '(') depth++;
          else if (d === ')') { depth--; if (depth === 0) { closed = true; break; } }
          m++;
        }
        if (!closed) break;
      }
      k++;
    }
    if (k > end + 1) { end = k; text = s.slice(i, end); }
  }
  text = trimAutolink(text);
  if (text.length <= scheme.length + 1) return null;
  return { text, end: i + text.length };
}
// Parse an autolink in angle brackets starting at s[i] === '<'.
// Returns {href, text, end} or null.
function parseAngleAutolink(s, i) {
  if (s[i] !== '<') return null;
  // scheme: 2-32 chars
  let j = i + 1;
  if (j < s.length && /[A-Za-z]/.test(s[j])) {
    let k = j;
    while (k < s.length && /[A-Za-z0-9+.\-]/.test(s[k])) k++;
    const scheme = s.slice(j, k);
    if (scheme.length >= 2 && scheme.length <= 32 && s[k] === ':') {
      let m = k + 1;
      while (m < s.length && s[m] !== '>' && s[m] !== ' ' && s[m] !== '\t' && s[m] !== '\n' && s[m] !== '\r' && s[m] !== '<') m++;
      if (m > k + 1 && s[m] === '>') {
        const text = s.slice(i + 1, m);
        return { href: text, text, end: m + 1 };
      }
    }
  }
  // email: local@domain with a dot in the domain
  const em = parseBareEmail(s, i + 1);
  if (em && s[em.end] === '>') {
    return { href: 'mailto:' + em.text, text: em.text, end: em.end + 1 };
  }
  return null;
}
// Parse a raw HTML tag (open, close, comment, PI, declaration, CDATA)
// starting at s[i] === '<'. Returns the index just past the tag, or -1.
function parseHtmlTag(s, i) {
  if (s[i] !== '<') return -1;
  const c1 = s[i + 1];
  if (c1 === '!') {
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 2);
      return e === -1 ? -1 : e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    // declaration: <!NAME<whitespace>...>
    if (c1 === '!' && i + 2 < s.length && /[A-Z]/.test(s[i + 2])) {
      let j = i + 2;
      while (j < s.length && /[A-Z]/.test(s[j])) j++;
      if (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) {
        const e = s.indexOf('>', j);
        return e === -1 ? -1 : e + 1;
      }
    }
    return -1;
  }
  if (c1 === '?') {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (c1 === '/') {
    let j = i + 2;
    if (j >= s.length || !/[A-Za-z]/.test(s[j])) return -1;
    while (j < s.length && /[A-Za-z0-9\-]/.test(s[j])) j++;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  if (!/[A-Za-z]/.test(c1)) return -1;
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9\-]/.test(s[j])) j++;
  // attributes
  while (true) {
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
    if (s[k] === '>') return k + 1;
    if (s[k] === '/' && s[k + 1] === '>') return k + 2;
    if (k === j) return -1; // no whitespace before attribute, and not '>' or '/>'
    j = k;
    if (!/[A-Za-z_:]/.test(s[j])) return -1;
    while (j < s.length && /[A-Za-z0-9_.:\-]/.test(s[j])) j++;
    let k2 = j;
    while (k2 < s.length && (s[k2] === ' ' || s[k2] === '\t' || s[k2] === '\n' || s[k2] === '\r')) k2++;
    if (s[k2] === '=') {
      j = k2 + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < s.length && s[j] !== q) j++;
        if (j >= s.length) return -1;
        j++;
      } else {
        const vs = j;
        while (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '\r' &&
          s[j] !== '"' && s[j] !== "'" && s[j] !== '=' && s[j] !== '<' && s[j] !== '>' && s[j] !== '`') j++;
        if (j === vs) return -1;
      }
    }
  }
}
// Flanking for a delimiter run s[i..i+n).
function flank(s, i, n) {
  const prev = i - 1, next = i + n;
  const prevWs = prev < 0 || isSpaceCh(s[prev]);
  const nextWs = next >= s.length || isSpaceCh(s[next]);
  const prevPunct = prev >= 0 && isUniPunct(s[prev]);
  const nextPunct = next < s.length && isUniPunct(s[next]);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return { left, right, prevPunct, nextPunct };
}

// ---------- inline scanner ----------
// Node kinds: text, raw, code, br, soft, delim, open, link, em, strong, del.
// scanInline returns a flat node array (link nodes hold child arrays).
// whether an unclosed raw-HTML <a> tag has been seen in this document:
// while set, bare-URL/www/bare-email autolinks are suppressed (marked
// treats later text as inside the link), but explicit <...> autolinks
// and markdown links still work
let inAnchor = false;
function scanInline(s, refs) {
  const nodes = [];
  const openers = []; // {idx, img, pos}
  let textBuf = '';
  function flush() {
    if (textBuf === '') return;
    const last = nodes[nodes.length - 1];
    if (last && last.t === 'text') last.s += textBuf;
    else nodes.push({ t: 'text', s: textBuf });
    textBuf = '';
  }
  function pushText(str) { textBuf += str; }
  function deactivateOpener(op) {
    const nd = nodes[op.idx];
    if (nd && nd.t === 'open') { nd.t = 'text'; nd.s = op.img ? '![' : '['; }
  }
  let i = 0;
  const N = s.length;
  while (i < N) {
    const c = s[i];
    // code span
    if (c === '`') {
      let n = 0;
      while (i + n < N && s[i + n] === '`') n++;
      let m = i + n, found = -1;
      while (m < N) {
        if (s[m] === '`') {
          let e = m, nn = 0;
          while (e < N && s[e] === '`') { e++; nn++; }
          if (nn === n) { found = m; break; }
          m = e;
        } else m++;
      }
      if (found !== -1) {
        let content = s.slice(i + n, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          content.trim() !== '') content = content.slice(1, -1);
        flush();
        nodes.push({ t: 'code', s: content });
        i = found + n;
        continue;
      }
      pushText(s.slice(i, i + n));
      i += n;
      continue;
    }
    // backslash
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') { flush(); nodes.push({ t: 'br' }); i += 2; while (s[i] === ' ' || s[i] === '\t') i++; continue; }
      if (nx !== undefined && isAsciiPunct(nx)) { pushText(nx); i += 2; continue; }
      pushText('\\'); i++;
      continue;
    }
    // newline: hard break if the pending text ends with 2+ spaces
    if (c === '\n') {
      let sp = 0;
      while (sp < textBuf.length && textBuf[textBuf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        textBuf = textBuf.slice(0, textBuf.length - sp);
        flush();
        nodes.push({ t: 'br' });
        i++;
        while (s[i] === ' ' || s[i] === '\t') i++;
      } else {
        flush();
        nodes.push({ t: 'soft' });
        i++;
      }
      continue;
    }
    // emphasis / strikethrough delimiters
    if (c === '*' || c === '_' || c === '~') {
      let n = 0;
      while (i + n < N && s[i + n] === c) n++;
      if (c === '~' && n >= 3) { pushText(s.slice(i, i + n)); i += n; continue; }
      const f = flank(s, i, n);
      let open = false, close = false;
      if (c === '_') {
        open = f.left && (!f.right || f.prevPunct);
        close = f.right && (!f.left || f.nextPunct);
      } else {
        open = f.left; close = f.right;
      }
      flush();
      nodes.push({ t: 'delim', ch: c, n, open, close });
      i += n;
      continue;
    }
    // entity
    if (c === '&') {
      const e = parseEntityAt(s, i);
      if (e) {
        flush();
        if (e.kind === 'named') nodes.push({ t: 'raw', s: '&' + e.name + ';' });
        else nodes.push({ t: 'text', s: e.ch });
        i += e.len;
        continue;
      }
      pushText('&'); i++;
      continue;
    }
    // raw HTML / angle autolink
    if (c === '<') {
      const au = parseAngleAutolink(s, i);
      if (au) {
        flush();
        nodes.push({ t: 'link', href: au.href, title: null, children: [{ t: 'text', s: au.text }], auto: true, explicit: true });
        i = au.end;
        continue;
      }
      const tagEnd = parseHtmlTag(s, i);
      if (tagEnd !== -1) {
        flush();
        const tagText = s.slice(i, tagEnd);
        if (/^<a(\s|\/|>)/i.test(tagText) && !/\/>$/.test(tagText)) inAnchor = true;
        else if (/^<\/a\s*>/i.test(tagText)) inAnchor = false;
        nodes.push({ t: 'raw', s: tagText });
        i = tagEnd;
        continue;
      }
      pushText('<'); i++;
      continue;
    }
    // image / link opener
    if (c === '!' && s[i + 1] === '[') {
      flush();
      nodes.push({ t: 'open', img: true });
      openers.push({ idx: nodes.length - 1, img: true, pos: i });
      i += 2;
      continue;
    }
    if (c === '[') {
      flush();
      nodes.push({ t: 'open', img: false });
      openers.push({ idx: nodes.length - 1, img: false, pos: i });
      i++;
      continue;
    }
    // link closer
    if (c === ']') {
      if (openers.length === 0) { pushText(']'); i++; continue; }
      const op = openers[openers.length - 1];
      const resolved = tryResolveLink(s, i, op, refs);
      if (resolved) {
        flush();
        const children = nodes.slice(op.idx + 1);
        if (!op.img && containsLink(children)) {
          // a link may not contain another link (cm-520)
          deactivateOpener(op);
          openers.pop();
          pushText(']');
          i++;
          continue;
        }
        const node = { t: 'link', href: resolved.href, title: resolved.title, children: op.img ? children : unlinkAuto(children), img: op.img };
        nodes.length = op.idx;
        nodes.push(node);
        openers.pop();
        // (no blanket deactivation of earlier link openers: an earlier
        // opener that later tries to form a link is blocked then by the
        // containsLink check, and deactivating it here would let an
        // outer image swallow the wrong ']' -- cm-520)
        i = resolved.end;
        continue;
      }
      // not a link: opener becomes literal text
      deactivateOpener(op);
      openers.pop();
      pushText(']');
      i++;
      continue;
    }
    // www. autolink (suppressed inside an unclosed <a>)
    if (!inAnchor && c === 'w' && s.startsWith('www.', i) && (i === 0 || !isWordChar(s[i - 1]))) {
      const w = parseWww(s, i);
      if (w) {
        flush();
        nodes.push({ t: 'link', href: 'http://' + w.text, title: null, children: [{ t: 'text', s: w.text }], auto: true });
        i = w.end;
        continue;
      }
    }
    // scheme:// autolink (suppressed inside an unclosed <a>)
    if (!inAnchor && (c === 'h' || c === 'H' || c === 'f' || c === 'F')) {
      const sc = parseSchemeSlash(s, i);
      if (sc) {
        flush();
        nodes.push({ t: 'link', href: sc.text, title: null, children: [{ t: 'text', s: sc.text }], auto: true });
        i = sc.end;
        continue;
      }
    }
    // mailto:/xmpp: autolink (suppressed inside an unclosed <a>)
    if (!inAnchor && (c === 'm' || c === 'M' || c === 'x' || c === 'X')) {
      const se = parseSchemeEmail(s, i);
      if (se) {
        flush();
        nodes.push({ t: 'link', href: se.text, title: null, children: [{ t: 'text', s: se.text }], auto: true });
        i = se.end;
        continue;
      }
    }
    // bare email (look back for the local part when we hit '@';
    // suppressed inside an unclosed <a>)
    if (!inAnchor && c === '@') {
      let ls = i - 1;
      while (ls >= 0 && isLocalChar(s[ls])) ls--;
      ls++;
      let localLen = i - ls;
      if (localLen > 0) {
        const local = s.slice(ls, i);
        // an odd run of backslashes before the local part escapes its
        // first char: it is literal text, not an email (cm-606)
        let nb = 0;
        for (let b = ls - 1; b >= 0 && s[b] === '\\'; b--) nb++;
        if (nb % 2 === 0) {
          // gather the trailing literal text (textBuf + text/delim
          // nodes) and check it is exactly the local part; the local
          // part may span '_' delim nodes (gfm-632)
          let need = localLen, txt = '', ok = true;
          if (textBuf.length > 0) {
            const take = Math.min(textBuf.length, need);
            txt = textBuf.slice(textBuf.length - take) + txt;
            need -= take;
          }
          for (let k = nodes.length - 1; k >= 0 && need > 0; k--) {
            const nd = nodes[k];
            if (nd.t === 'text') {
              const take = Math.min(nd.s.length, need);
              txt = nd.s.slice(nd.s.length - take) + txt;
              need -= take;
            } else if (nd.t === 'delim') {
              const take = Math.min(nd.n, need);
              txt = nd.ch.repeat(take) + txt;
              need -= take;
            } else { ok = false; break; }
          }
          if (ok && need === 0 && txt === local) {
            const hasOpenUs = nodes.some(nd => nd.t === 'delim' && nd.ch === '_' && nd.n >= 2);
            let em = parseBareEmail(s, ls, hasOpenUs);
            if (em) {
              // email inside __...__: the leading '__' is the strong
              // opener, not part of the address (the trailing '__' was
              // already stripped from the domain by parseBareEmail)
              if (hasOpenUs && em.text.startsWith('__') && s[em.end] === '_') {
                em = { text: em.text.slice(2), end: em.end };
                localLen -= 2;
              }
              let rem = localLen;
              if (textBuf.length > 0) {
                const take = Math.min(textBuf.length, rem);
                textBuf = textBuf.slice(0, textBuf.length - take);
                rem -= take;
              }
              while (rem > 0 && nodes.length > 0) {
                const nd = nodes[nodes.length - 1];
                if (nd.t === 'text') {
                  const take = Math.min(nd.s.length, rem);
                  nd.s = nd.s.slice(0, nd.s.length - take);
                  rem -= take;
                  if (nd.s.length === 0) nodes.pop();
                } else if (nd.t === 'delim') {
                  const take = Math.min(nd.n, rem);
                  nd.n -= take;
                  rem -= take;
                  if (nd.n === 0) nodes.pop();
                } else break;
              }
              flush();
              nodes.push({ t: 'link', href: 'mailto:' + em.text, title: null, children: [{ t: 'text', s: em.text }], auto: true });
              i = em.end;
              continue;
            }
          }
        }
      }
      pushText('@'); i++;
      continue;
    }
    pushText(c);
    i++;
  }
  flush();
  return nodes;
}
function isWordChar(c) {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_');
}
// True if any node in the list (or its descendants) is an explicit
// (non-autolink) link. An image is not a link, and a bare-URL/email
// autolink inside link text becomes plain text when the link forms.
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' && !nd.img && !nd.auto) return true;
    if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
      if (containsLink(nd.children)) return true;
    }
  }
  return false;
}
// Replace autolink nodes inside a link's children with plain text
// (a bare URL/email inside link text is not a nested link).
function unlinkAuto(nodes) {
  return nodes.map(nd => {
    if (nd.t === 'link' && nd.auto && !nd.explicit) return { t: 'text', s: nd.children[0].s };
    if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del' || nd.t === 'link') {
      return { ...nd, children: unlinkAuto(nd.children) };
    }
    return nd;
  });
}
// Try to resolve a link at s[i] === ']' with opener op.
// Returns {href, title, end} or null. end is the index just past the link.
function tryResolveLink(s, i, op, refs) {
  const textStart = op.pos + (op.img ? 2 : 1);
  const rawText = s.slice(textStart, i);
  // inline link: '(' must immediately follow ']'
  if (s[i + 1] === '(') {
    const k = skipWs(s, i + 2);
    const dest = parseDest(s, k);
    if (dest) {
      let title = null, m = skipWs(s, dest.next);
      let ok = true;
      if (s[m] === '"' || s[m] === "'" || s[m] === '(') {
        const t = parseTitle(s, m);
        if (!t) ok = false;
        else { title = t.title; m = skipWs(s, t.next); }
      }
      if (ok && s[m] === ')') return { href: dest.dest, title, end: m + 1 };
    }
    // a failed inline link falls through to the reference / shortcut
  }
  // full / collapsed reference: '[' must immediately follow ']'
  if (s[i + 1] === '[') {
    if (s[i + 2] === ']') {
      // collapsed reference: [text][]
      const ref = refs.get(normalizeLabel(rawText));
      if (ref) return { href: ref.dest, title: ref.title, end: i + 3 };
      return null; // collapsed label is the shortcut label: both fail
    } else {
      const lab = parseLabel(s, i + 1);
      if (lab) {
        const ref = refs.get(normalizeLabel(lab.label));
        if (ref) return { href: ref.dest, title: ref.title, end: lab.end };
        // full reference parsed but its label is undefined: the opener
        // is dead, do NOT fall through to the shortcut (cm-571)
        return null;
      }
      // the second bracket could not be parsed: fall through to shortcut
    }
  }
  // shortcut reference
  const ref = refs.get(normalizeLabel(rawText));
  if (!ref) return null;
  return { href: ref.dest, title: ref.title, end: i + 1 };
}
// ---------- emphasis (delimiter stack, CommonMark appendix A phase 2) ----------
function processEmphasis(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' || nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') processEmphasis(nd.children);
  }
  while (true) {
    let matched = false;
    for (let di = 0; di < nodes.length; di++) {
      const d = nodes[di];
      if (d.t !== 'delim' || !d.close) continue;
      for (let oi = di - 1; oi >= 0; oi--) {
        const o = nodes[oi];
        if (o.t !== 'delim' || o.ch !== d.ch || !o.open) continue;
        // odd-match rule (CommonMark rule 9): if either delimiter can
        // both open and close, and the sum of the lengths is a multiple
        // of 3 (unless both lengths are multiples of 3), no match.
        if (((o.open && o.close) || (d.open && d.close)) &&
          (o.n + d.n) % 3 === 0 && (o.n % 3 !== 0 || d.n % 3 !== 0)) continue;
        // Lookahead: a closer must not steal a longer opener when a
        // later closer of at least the opener's length could take it
        // as a strong instead ('**a *b*c* d**': the middle '*' stays
        // literal and the outer '**' pair becomes a strong).
        if (o.n > d.n) {
          let later = false;
          for (let dj = di + 1; dj < nodes.length; dj++) {
            const nd2 = nodes[dj];
            if (nd2.t === 'delim' && nd2.ch === d.ch && nd2.close && nd2.n >= o.n) {
              if (!(((o.open && o.close) || (nd2.open && nd2.close)) &&
                (o.n + nd2.n) % 3 === 0 && (o.n % 3 !== 0 || nd2.n % 3 !== 0))) { later = true; break; }
            }
          }
          if (later) continue;
        }
        const use = (o.n >= 2 && d.n >= 2) ? 2 : 1;
        const tag = d.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const children = nodes.slice(oi + 1, di);
        const rep = [];
        if (o.n > use) rep.push({ t: 'delim', ch: o.ch, n: o.n - use, open: o.open, close: o.close });
        rep.push({ t: tag, children });
        if (d.n > use) rep.push({ t: 'delim', ch: d.ch, n: d.n - use, open: d.open, close: d.close });
        nodes.splice(oi, di - oi + 1, ...rep);
        matched = true;
        break;
      }
      if (matched) break;
    }
    if (!matched) break;
  }
}
// ---------- inline rendering ----------
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += esc(nd.s); break;
      case 'raw': out += nd.s; break;
      case 'code': out += '<code>' + esc(nd.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'soft': out += '\n'; break;
      case 'delim': out += nd.ch.repeat(nd.n); break;
      case 'open': out += nd.img ? '![' : '['; break;
      case 'em': out += '<em>' + renderInline(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(nd.children) + '</del>'; break;
      case 'link': {
        if (nd.img) {
          out += '<img src="' + hrefAttr(nd.href) + '" alt="' + altText(nd.children) + '"' +
            (nd.title != null ? ' title="' + escAttrEnt(nd.title) + '"' : '') + '>';
        } else {
          out += '<a href="' + hrefAttr(nd.href) + '"' +
            (nd.title != null ? ' title="' + escAttrEnt(nd.title) + '"' : '') + '>' +
            renderInline(nd.children) + '</a>';
        }
        break;
      }
    }
  }
  return out;
}
// Plain-text rendering of inline nodes (for image alt attributes).
function altText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += esc(nd.s); break;
      case 'raw': out += nd.s; break;
      case 'code': out += esc(nd.s); break;
      case 'br': case 'soft': out += ' '; break;
      case 'delim': out += nd.ch.repeat(nd.n); break;
      case 'open': out += nd.img ? '![' : '['; break;
      case 'em': case 'strong': case 'del': out += altText(nd.children); break;
      case 'link': out += nd.img ? altText(nd.children) : altText(nd.children); break;
    }
  }
  return out;
}
// Parse inline markdown to HTML (single entry point for blocks).
function inlineToHtml(s, refs) {
  if (!s) return '';
  const nodes = scanInline(s, refs);
  processEmphasis(nodes);
  return renderInline(nodes);
}

// ---------- block parser ----------
// A line view: {s (mutable for partial tabs), pos, col, nl}.
function isBlankLineStr(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}
function indentCols(L) {
  let col = L.col, pos = L.pos, n = 0;
  while (pos < L.s.length) {
    const c = L.s[pos];
    if (c === ' ') { pos++; col++; n++; }
    else if (c === '\t') { const nc = col + (4 - col % 4); n += nc - col; col = nc; pos++; }
    else break;
  }
  return n;
}
function contentPosAfter(L, maxCols) {
  let pos = L.pos, col = L.col, n = 0;
  while (pos < L.s.length && n < maxCols) {
    const c = L.s[pos];
    if (c === ' ') { pos++; col++; n++; }
    else if (c === '\t') {
      const nc = col + (4 - col % 4);
      if (n + (nc - col) > maxCols) break;
      n += nc - col; col = nc; pos++;
    } else break;
  }
  return { pos, col };
}
function consumeCols(L, n) {
  while (n > 0 && L.pos < L.s.length) {
    const c = L.s[L.pos];
    if (c === ' ') { L.pos++; L.col++; n--; }
    else if (c === '\t') {
      const nc = L.col + (4 - L.col % 4);
      const w = nc - L.col;
      if (w <= n) { L.pos++; L.col = nc; n -= w; }
      else {
        L.s = L.s.slice(0, L.pos) + ' '.repeat(w) + L.s.slice(L.pos + 1);
        L.pos++; L.col++; n--;
      }
    } else break;
  }
}
// Strip up to n leading whitespace characters for a fenced-code line:
// each space or tab counts as one character, and a tab inside the
// stripped region is removed whole (marked's behaviour).
function stripFenceIndent(L, n) {
  while (n > 0 && L.pos < L.s.length) {
    const c = L.s[L.pos];
    if (c === ' ') { L.pos++; L.col++; n--; }
    else if (c === '\t') { const w = 4 - L.col % 4; L.pos++; L.col += w; n--; }
    else break;
  }
}
// Expand leading tabs (before any non-whitespace) in place to spaces,
// using the current column for the tab stops. Used for code-block
// content lines after the indent has been stripped.
function expandLeadingTabs(L) {
  let p = L.pos, col = L.col;
  while (p < L.s.length && (L.s[p] === ' ' || L.s[p] === '\t')) {
    if (L.s[p] === '\t') {
      const w = 4 - col % 4;
      L.s = L.s.slice(0, p) + ' '.repeat(w) + L.s.slice(p + 1);
      p += w; col += w;
    } else { p++; col++; }
  }
}
// Thematic break: 3+ of the same marker (* - _) with spaces/tabs only.
function isThematic(rest) {
  if (!rest) return false;
  const m = rest[0];
  if (m !== '*' && m !== '-' && m !== '_') return false;
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === m) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}
// ATX heading: returns {level, text} or null.
function matchAtx(rest) {
  if (!rest || rest[0] !== '#') return null;
  let i = 0;
  while (i < rest.length && rest[i] === '#') i++;
  if (i > 6) return null;
  if (i < rest.length && rest[i] !== ' ' && rest[i] !== '\t') return null;
  let text = rest.slice(i).trim();
  if (/^#+$/.test(text)) text = '';
  else {
    const m = /^(.*?)[ \t]+#+$/.exec(text);
    if (m) text = m[1].trimEnd();
  }
  return { level: i, text };
}
// Fenced code start: returns {ch, len, lang} or null.
function matchFence(rest) {
  if (!rest) return null;
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let i = 0;
  while (i < rest.length && rest[i] === ch) i++;
  if (i < 3) return null;
  const info = rest.slice(i);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  const t = unescapeStr(info).trim();
  let lang = '';
  if (t) {
    const sp = t.search(/[ \t]/);
    lang = sp === -1 ? t : t.slice(0, sp);
  }
  return { ch, len: i, lang };
}
// Closing fence for a fenced code block.
function isClosingFence(rest, code) {
  if (!rest) return false;
  const ch = rest[0];
  if (ch !== code.fenceChar) return false;
  let i = 0;
  while (i < rest.length && rest[i] === ch) i++;
  if (i < code.fenceLen) return false;
  for (let k = i; k < rest.length; k++) if (rest[k] !== ' ' && rest[k] !== '\t') return false;
  return true;
}
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
// HTML block start: returns {type} (1-7) or null.
function matchHtmlStart(rest) {
  if (!rest || rest[0] !== '<') return null;
  const low = rest.toLowerCase();
  if (low.startsWith('<script') || low.startsWith('<pre') || low.startsWith('<style') || low.startsWith('<textarea')) {
    const m = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
    if (m) return { type: 1 };
  }
  if (rest.startsWith('<!--')) return { type: 2 };
  if (rest.startsWith('<?')) return { type: 3 };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4 };
  if (rest.startsWith('<![CDATA[')) return { type: 5 };
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9]*)(?:[\s/>]|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6 };
  const tagEnd = parseHtmlTag(rest, 0);
  if (tagEnd !== -1) {
    let k = tagEnd;
    while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
    if (k === rest.length) return { type: 7 };
  }
  return null;
}
function htmlEndReached(type, rest) {
  const low = rest.toLowerCase();
  if (type === 1) {
    return low.indexOf('</script') !== -1 || low.indexOf('</pre') !== -1 ||
      low.indexOf('</style') !== -1 || low.indexOf('</textarea') !== -1;
  }
  if (type === 2) return rest.indexOf('-->') !== -1;
  if (type === 3) return rest.indexOf('?>') !== -1;
  if (type === 4) return rest.indexOf('>') !== -1;
  if (type === 5) return rest.indexOf(']]>') !== -1;
  return false;
}
// Setext underline: returns 1 or 2, or 0.
function matchSetext(rest) {
  if (!rest) return 0;
  if (rest[0] === ' ' || rest[0] === '\t') return 0;
  const ch = rest[0];
  if (ch !== '=' && ch !== '-') return 0;
  let i = 0;
  while (i < rest.length && rest[i] === ch) i++;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
  return i === rest.length ? (ch === '=' ? 1 : 2) : 0;
}
// List marker at the start of rest: returns info or null.
function matchList(rest) {
  if (!rest) return null;
  const c = rest[0];
  if (c === '-' || c === '+' || c === '*') {
    if (rest.length === 1 || rest[1] === ' ' || rest[1] === '\t') {
      return { ordered: false, bullet: c, markerLen: 1 };
    }
    return null;
  }
  if (c >= '0' && c <= '9') {
    let i = 0;
    while (i < rest.length && rest[i] >= '0' && rest[i] <= '9') i++;
    if (i > 9 || i === 0) return null;
    const d = rest[i];
    if (d !== '.' && d !== ')') return null;
    if (i + 1 < rest.length && rest[i + 1] !== ' ' && rest[i + 1] !== '\t') return null;
    return { ordered: true, start: parseInt(rest.slice(0, i), 10), delim: d, markerLen: i + 1 };
  }
  return null;
}
// Split a table row line into cells (handles \| and code spans).
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') { cur += '\\|'; i += 2; continue; }
    if (c === '`') {
      let k = i, run = 0;
      while (k < n && line[k] === '`') { k++; run++; }
      cur += line.slice(i, k);
      i = k;
      // skip to a matching run of the same length (pipes inside are not splits)
      let m = i, found = -1;
      while (m < n) {
        if (line[m] === '\\' && m + 1 < n && line[m + 1] === '|') { m += 2; continue; }
        if (line[m] === '|') break; // a cell separator ends the code span search
        if (line[m] === '`') {
          let e = m, nn = 0;
          while (e < n && line[e] === '`') { e++; nn++; }
          if (nn === run) { found = e; break; }
          m = e;
        } else m++;
      }
      if (found !== -1) { cur += line.slice(i, found).split('\\|').join('|'); i = found; }
      else {
        // no closer before the next cell separator: the run and the text
        // up to the '|' are literal; a stray backtick inside must not
        // pair across the cell boundary
        let p2 = i;
        while (p2 < n) {
          if (line[p2] === '\\' && p2 + 1 < n && line[p2 + 1] === '|') { p2 += 2; continue; }
          if (line[p2] === '|') break;
          p2++;
        }
        cur += line.slice(i, p2);
        i = p2;
      }
      continue;
    }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  const trimmed = line.trim();
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && cells.length > 0) cells.pop();
  return cells.map(x => x.trim());
}
// Table delimiter row: returns the align array or null.
function matchTableDelimiter(rest) {
  if (!rest || rest[0] === ' ' || rest[0] === '\t') return null;
  const cells = splitTableRow(rest);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    const t = cell.trim();
    const m = /^(:?)-+(:?)$/.exec(t);
    if (!m) return null;
    const left = t.startsWith(':'), right = t.endsWith(':');
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return align;
}
// ---------- link reference definitions ----------
// Extract leading link reference definitions from a paragraph's text.
// Returns the remaining text ('' when the paragraph was only definitions).
function extractRefDefs(text, refs) {
  let pos = 0;
  const N = text.length;
  while (pos < N) {
    if (pos > 0 && text[pos - 1] !== '\n') break;
    let p = pos, cols = 0;
    while (p < N && cols < 3) {
      const c = text[p];
      if (c === ' ') { p++; cols++; }
      else if (c === '\t') { const nc = cols + (4 - cols % 4); if (nc > 3) break; cols = nc; p++; }
      else break;
    }
    if (text[p] !== '[') break;
    const lab = parseLabel(text, p);
    if (!lab || text[lab.end] !== ':') break;
    let q = lab.end + 1;
    let dest = null;
    let r = skipSpaces(text, q);
    if (r < N && text[r] !== '\n') {
      dest = parseDest(text, r);
      if (!dest) break;
      q = dest.next;
    } else {
      // destination on the next line (any indentation)
      let r2 = r;
      if (text[r2] === '\n') r2++;
      r2 = skipSpaces(text, r2);
      dest = parseDest(text, r2);
      if (!dest) break;
      q = dest.next;
    }
    let title = null, endQ = q;
    const t1 = skipSpaces(text, q);
    if (t1 > q && t1 < N && text[t1] !== '\n' && (text[t1] === '"' || text[t1] === "'" || text[t1] === '(')) {
      // title on the same line (must be preceded by whitespace)
      const t = parseTitle(text, t1);
      if (!t) break;
      const r3 = skipSpaces(text, t.next);
      if (r3 >= N || text[r3] === '\n') { title = t.title; endQ = r3; }
      else break; // junk after the title on the same line: the def fails
    } else if (t1 < N && text[t1] === '\n') {
      // title may be on the next line (any indentation)
      let r2 = t1 + 1;
      r2 = skipSpaces(text, r2);
      const t = parseTitle(text, r2);
      if (t) {
        const r3 = skipSpaces(text, t.next);
        if (r3 >= N || text[r3] === '\n') { title = t.title; endQ = r3; }
        // else: junk after a next-line title: keep the def without the title
      }
    }
    const e = skipSpaces(text, endQ);
    if (e < N && text[e] !== '\n') break;
    const norm = normalizeLabel(lab.label);
    if (!refs.has(norm)) refs.set(norm, { dest: dest.dest, title });
    pos = e;
    if (pos < N && text[pos] === '\n') pos++;
    else break;
  }
  return text.slice(pos);
}

// ---------- block parsing driver ----------
// Node kinds: doc, para, heading, code, html, hr, quote, list, item, table.
function parseBlocks(src) {
  const refs = new Map();
  const doc = { t: 'doc', children: [] };
  const stack = [doc];
  // split into lines (no phantom line after a trailing newline)
  let rawLines = src.split('\n');
  const endsNL = src.endsWith('\n');
  if (endsNL) rawLines.pop();
  const lines = rawLines.map((s, idx) => ({
    s, nl: idx < rawLines.length - 1 || endsNL,
  }));
  // --- finalisation helpers ---
  function addToParent(node, parent) {
    parent.children.push(node);
  }
  function finalizePara(para) {
    const text = para.lines.join('\n');
    const rest = extractRefDefs(text, refs);
    if (rest === '') return false;
    para.lines = rest.split('\n');
    return true;
  }
  function finalizeItem(item) {
    // task list: first child paragraph starting with [ ] / [x] / [X] + space
    const first = item.children[0];
    if (first && first.t === 'para' && first.lines.length > 0) {
      const text = first.lines.join('\n');
      const m = /^\[( |x|X)\][ \t]+(\S)/.exec(text);
      if (m) {
        item.task = m[1] === ' ' ? 'unchecked' : 'checked';
        // strip "[ ]" plus the following spaces/tabs from the first line
        let k = 3;
        while (k < first.lines[0].length && (first.lines[0][k] === ' ' || first.lines[0][k] === '\t')) k++;
        first.lines[0] = first.lines[0].slice(k);
      }
    }
  }
  function closeTop() {
    const node = stack.pop();
    const parent = stack[stack.length - 1];
    if (node.t === 'para') {
      if (finalizePara(node)) addToParent(node, parent);
      return;
    }
    if (node.t === 'item') finalizeItem(node);
    addToParent(node, parent);
  }
  function closeTo(idx) { while (stack.length > idx) closeTop(); }
  function tip() { return stack[stack.length - 1]; }
  // --- block start helpers (operate on the shared line view L) ---
  let L = null;
  function startsBlockquote(rest) {
    return rest.length > 0 && rest[0] === '>';
  }
  function startsListInterrupting(rest) {
    const li = matchList(rest);
    if (!li) return false;
    // an empty item does not interrupt a paragraph
    let p = li.markerLen;
    while (p < rest.length && (rest[p] === ' ' || rest[p] === '\t')) p++;
    if (p >= rest.length) return false;
    if (!li.ordered) return true;
    if (li.start === 1) return true;
    // an ordered list with any start number interrupts a paragraph
    // that sits directly inside a list item (marked behaviour)
    const parent = stack.length >= 2 ? stack[stack.length - 2] : null;
    return !!(parent && parent.t === 'item');
  }
  function lineStartsInterrupting(rest) {
    if (isThematic(rest)) return true;
    if (matchAtx(rest)) return true;
    if (matchFence(rest)) return true;
    const h = matchHtmlStart(rest);
    if (h && h.type <= 6) return true;
    if (startsBlockquote(rest)) return true;
    if (startsListInterrupting(rest)) return true;
    return false;
  }
  // Start new blocks on the current line; the stack top must be a container.
  // Consume a '>' marker plus one optional following space (a tab counts
  // as one space, partially), then expand a leading tab in the remaining
  // content to spaces.
  function consumeQuote() {
    const cp = contentPosAfter(L, 3);
    L.pos = cp.pos + 1; L.col = cp.col + 1;
    if (L.s[L.pos] === ' ') { L.pos++; L.col++; }
    else if (L.s[L.pos] === '\t') {
      const w = 4 - L.col % 4;
      L.s = L.s.slice(0, L.pos) + ' '.repeat(w) + L.s.slice(L.pos + 1);
      L.pos++; L.col++;
    }
    if (L.s[L.pos] === '\t') {
      const w = 4 - L.col % 4;
      L.s = L.s.slice(0, L.pos) + ' '.repeat(w) + L.s.slice(L.pos + 1);
    }
  }
  function startBlocks() {
    while (true) {
      // an empty remainder (only whitespace) starts no block
      if (isBlankLineStr(L.s.slice(L.pos))) return;
      // a list stays open only for a matching list item
      if (tip().t === 'list') {
        const cp0 = contentPosAfter(L, 3);
        const rest0 = L.s.slice(cp0.pos);
        const li0 = matchList(rest0);
        const top = tip();
        if (!li0 || isThematic(rest0) || li0.ordered !== top.ordered ||
          (li0.ordered ? top.delim !== li0.delim : top.bullet !== li0.bullet)) {
          closeTop();
          continue;
        }
      }
      // a new block inside an item after a blank line makes its list
      // loose (checked here, after a list may have been closed above,
      // so the tip can be the item that gains the block -- cm-325)
      const parent0 = tip();
      if (parent0.t === 'item' && parent0.children.length > 0 && parent0.blankAfterContent) {
        const li0 = stack[stack.length - 2];
        if (li0 && li0.t === 'list') li0.loose = true;
      }
      if (parent0.t === 'item' && parent0.children.length > 0 && parent0.blankAfterContent) {
        // the new block is content inside every open item, so a blank
        // line no longer separates those items from what follows (cm-319)
        for (let k2 = 1; k2 < stack.length; k2++) {
          if (stack[k2].t === 'item') stack[k2].blankAfterContent = false;
        }
      }
      const ind = indentCols(L);
      if (ind >= 4) {
        consumeCols(L, 4);
        const code = { t: 'code', fenced: false, lines: [L.s.slice(L.pos)], nl: [L.nl] };
        stack.push(code);
        return;
      }
      const cp = contentPosAfter(L, 3);
      const rest = L.s.slice(cp.pos);
      if (rest.startsWith(' ') || rest.startsWith('\t')) {
        // indent was > 3 after all: plain paragraph
        stack.push({ t: 'para', lines: [L.s.slice(L.pos)], lastWasLazy: false });
        return;
      }
      if (isThematic(rest)) { addToParent({ t: 'hr' }, tip()); return; }
      const atx = matchAtx(rest);
      if (atx) { addToParent({ t: 'heading', level: atx.level, text: atx.text }, tip()); return; }
      const fence = matchFence(rest);
      if (fence) {
        stack.push({ t: 'code', fenced: true, fenceChar: fence.ch, fenceLen: fence.len, lang: fence.lang, fenceIndent: cp.col - L.col, nested: stack.length > 1, lines: [], nl: [] });
        return;
      }
      const html = matchHtmlStart(rest);
      if (html) {
        const node = { t: 'html', type: html.type, lines: [{ s: L.s.slice(L.pos), nl: L.nl }], nlKept: false, ended: false };
        if (html.type <= 5 && htmlEndReached(html.type, rest)) node.ended = true;
        stack.push(node);
        return;
      }
      if (rest[0] === '>') {
        const q = { t: 'quote', children: [] };
        stack.push(q);
        consumeQuote();
        continue;
      }
      const li = matchList(rest);
      if (li) {
        const top = tip();
        let list = null;
        if (top.t === 'list' && top.ordered === li.ordered &&
          (li.ordered ? top.delim === li.delim : top.bullet === li.bullet)) {
          list = top;
          if (list.blankAfterContent) list.loose = true;
          const lastIt = list.children[list.children.length - 1];
          if (lastIt && lastIt.blankAfterContent) list.loose = true;
          list.blankAfterContent = false;
        } else {
          list = {
            t: 'list', ordered: li.ordered, start: li.ordered ? li.start : 0,
            delim: li.ordered ? li.delim : null, bullet: li.ordered ? null : li.bullet,
            loose: false, blankAfterContent: false, children: [],
          };
          stack.push(list);
        }
        const item = { t: 'item', children: [], contentIndent: 0, blankAfterContent: false, task: null };
        // consume the marker
        const baseCol = L.col;
        L.pos = cp.pos + li.markerLen;
        L.col = cp.col + li.markerLen;
        // spaces after the marker
        let p = L.pos, c = L.col, spaces = 0;
        while (p < L.s.length && (L.s[p] === ' ' || L.s[p] === '\t')) {
          const nc = L.s[p] === ' ' ? c + 1 : c + (4 - c % 4);
          spaces += nc - c; c = nc; p++;
        }
        if (p >= L.s.length) {
          item.contentIndent = (cp.col - baseCol) + li.markerLen + 1;
          stack.push(item);
          return;
        }
        if (spaces === 0) { stack.push(item); return; } // cannot happen (matchList checked)
        // contentIndent is relative to the column where the line's
        // remainder started (baseCol): marker starts at cp.col.
        item.contentIndent = (cp.col - baseCol) + li.markerLen + (spaces <= 4 ? spaces : 1);
        consumeCols(L, spaces <= 4 ? spaces : 1);
        stack.push(item);
        continue;
      }
      stack.push({ t: 'para', lines: [L.s.slice(L.pos)], lastWasLazy: false });
      return;
    }
  }
  // --- per-line processing ---
  function processLine(line) {
    L = { s: line.s, pos: 0, col: 0, nl: line.nl };
    const lineBlank = isBlankLineStr(L.s);
    // walk open containers
    let k = 1, lazy = false;
    while (k < stack.length) {
      const b = stack[k];
      if (b.t === 'quote') {
        const cp = contentPosAfter(L, 3);
        if (L.s[cp.pos] === '>') { consumeQuote(); k++; continue; }
        if (lineBlank) { closeTo(k); break; }
        const cp2 = contentPosAfter(L, 3);
        const rest2 = L.s.slice(cp2.pos);
        if (tip().t === 'para' && !lineStartsInterrupting(rest2) && !matchList(rest2)) lazy = true;
        else closeTo(k);
        break;
      }
      if (b.t === 'item') {
        if (lineBlank) { k++; continue; }
        const ind = indentCols(L);
        if (ind < b.contentIndent) {
          // a fenced code block swallows a non-indented line too:
          // consume whatever indent is there and keep the block open
          if (tip().t === 'code' && tip().fenced) { consumeCols(L, ind); break; }
          const cp2 = contentPosAfter(L, 3);
          const rest2 = L.s.slice(cp2.pos);
          if (tip().t === 'para' && !lineStartsInterrupting(rest2) && !matchList(rest2)) lazy = true;
          else closeTo(k);
          break;
        }
        consumeCols(L, b.contentIndent);
        k++;
        continue;
      }
      if (b.t === 'list') { k++; continue; }
      break; // a leaf is the tip
    }
    // the remainder is blank only if the whole line is blank or the
    // remainder is empty; a whitespace-only remainder inside a container
    // is paragraph text (cm-241)
    if (lineBlank || L.s.slice(L.pos) === '') {
      // a blank line closes an empty list item (cm-280)
      if (tip().t === 'item' && tip().children.length === 0) closeTop();
      const tp0 = tip();
      if (tp0.t !== 'code' && tp0.t !== 'html') {
        // a blank line sets blankAfterContent on every item below the
        // deepest blockquote (a blank quote line inside an item's quote
        // loosens nothing, cm-320), so that a new block starting in any
        // of those items makes its list loose (cm-325); but only the
        // parent list of the *deepest* item gets the flag, so a blank
        // line inside a nested item does not loosen an outer list when
        // a new item is added to it (cm-319)
        let dq = 0;
        for (let k2 = 1; k2 < stack.length; k2++) if (stack[k2].t === 'quote') dq = k2;
        let deepestItem = -1;
        for (let k2 = stack.length - 1; k2 > dq; k2--) {
          if (stack[k2].t === 'item') {
            stack[k2].blankAfterContent = true;
            if (deepestItem === -1) deepestItem = k2;
          }
        }
        if (deepestItem !== -1) {
          if (stack[deepestItem - 1] && stack[deepestItem - 1].t === 'list') stack[deepestItem - 1].blankAfterContent = true;
        } else {
          for (let k2 = stack.length - 1; k2 > dq; k2--) {
            if (stack[k2].t === 'list') { stack[k2].blankAfterContent = true; break; }
          }
        }
      }
      const tp = tip();
      if (tp.t === 'para') closeTop();
      else if (tp.t === 'code') {
        if (tp.fenced) { stripFenceIndent(L, tp.fenceIndent); if (tp.nested) expandLeadingTabs(L); tp.lines.push(L.s.slice(L.pos)); tp.nl.push(line.nl); }
        else { consumeCols(L, 4); tp.lines.push(L.s.slice(L.pos)); tp.nl.push(line.nl); }
      } else if (tp.t === 'html') {
        // the trailing newline is dropped only by a truly empty line;
        // a whitespace-only line (spaces/tabs) keeps it
        if (tp.ended) { tp.nlKept = L.s.slice(L.pos) !== ''; closeTop(); }
        else if (tp.type === 6 || tp.type === 7) closeTop();
        else tp.lines.push({ s: L.s.slice(L.pos), nl: line.nl });
      } else if (tp.t === 'table') {
        // a line of spaces ending in a single tab is an empty table row,
        // not the end of the table; any other blank line closes it
        if (/^ *\t$/.test(L.s.slice(L.pos))) {
          const cells = splitTableRow(L.s.slice(L.pos));
          while (cells.length < tp.header.length) cells.push('');
          tp.rows.push(cells.slice(0, tp.header.length));
        } else closeTop();
      }
      return;
    }
    // lazy continuation line: append directly to the paragraph
    if (lazy) {
      const tp = tip();
      if (tp.t === 'para') {
        const ind = indentCols(L);
        if (ind >= 4) consumeCols(L, 4);
        let txt = L.s.slice(L.pos);
        const se = matchSetext(txt);
        if (se && tp.lastWasLazy && stack.length >= 2 && stack[stack.length - 2].t === 'quote') {
          txt = '    ' + txt;
        }
        tp.lines.push(txt);
        tp.lastWasLazy = true;
        return;
      }
    }
    const tp = tip();
    if (tp.t === 'para') {
      const cp = contentPosAfter(L, 3);
      const rest = L.s.slice(cp.pos);
      const se = matchSetext(rest);
      if (se) {
        const text = tp.lines.join('\n');
        const kept = extractRefDefs(text, refs);
        if (kept === '') {
          // the paragraph is only definitions: the setext line is text
          tp.lines.push(L.s.slice(L.pos));
          tp.lastWasLazy = false;
          return;
        }
        stack.pop(); // drop the paragraph; it becomes a heading instead
        if (kept !== '') addToParent({ t: 'heading', level: se, text: kept }, tip());
        return;
      }
      const dm = matchTableDelimiter(rest);
      if (dm) {
        const headerLine = tp.lines[tp.lines.length - 1];
        const hdr = splitTableRow(headerLine);
        if (hdr && hdr.length === dm.length) {
          const pre = tp.lines.slice(0, -1);
          stack.pop(); // drop the paragraph; its last line is the header
          const parent = tip();
          if (pre.length > 0) {
            const p2 = { t: 'para', lines: pre, lastWasLazy: false };
            if (finalizePara(p2)) addToParent(p2, parent);
          }
          stack.push({ t: 'table', align: dm, header: hdr, rows: [] });
          return;
        }
      }
      if (lineStartsInterrupting(rest)) {
        closeTop();
        startBlocks();
        return;
      }
      tp.lines.push(L.s.slice(L.pos));
      tp.lastWasLazy = false;
      return;
    }
    if (tp.t === 'code' && tp.fenced) {
      const cp = contentPosAfter(L, 3);
      const rest = L.s.slice(cp.pos);
      if (isClosingFence(rest, tp)) { closeTop(); return; }
      stripFenceIndent(L, tp.fenceIndent);
      if (tp.nested) expandLeadingTabs(L);
      tp.lines.push(L.s.slice(L.pos)); tp.nl.push(L.nl);
      return;
    }
    if (tp.t === 'code' && !tp.fenced) {
      const ind = indentCols(L);
      if (ind >= 4) {
        consumeCols(L, 4);
        tp.lines.push(L.s.slice(L.pos)); tp.nl.push(L.nl);
        return;
      }
      closeTop();
      startBlocks();
      return;
    }
    if (tp.t === 'html') {
      if (tp.ended) {
        // the end condition was met on an earlier line: this line starts
        // a new block, and the html block keeps its trailing newline
        tp.nlKept = true;
        closeTop();
        startBlocks();
        return;
      }
      const rest = L.s.slice(L.pos);
      tp.lines.push({ s: rest, nl: L.nl });
      if (htmlEndReached(tp.type, rest)) { tp.ended = true; }
      return;
    }
    if (tp.t === 'table') {
      const cp = contentPosAfter(L, 3);
      const rest = L.s.slice(cp.pos);
      if (lineStartsInterrupting(rest)) { closeTop(); startBlocks(); return; }
      const cells = splitTableRow(L.s.slice(L.pos));
      while (cells.length < tp.header.length) cells.push('');
      tp.rows.push(cells.slice(0, tp.header.length));
      return;
    }
    // tip is a container (or doc): start new blocks
    startBlocks();
  }
  for (const line of lines) processLine(line);
  while (stack.length > 1) {
    const nd = stack[stack.length - 1];
    if (nd.t === 'html') nd.nlKept = true;
    closeTop();
  }
  return { doc, refs };
}

// ---------- rendering ----------
function renderNodes(children, refs) {
  let out = '';
  for (const nd of children) out += renderNode(nd, refs);
  return out;
}
function renderNode(nd, refs) {
  switch (nd.t) {
    case 'para':
      return '<p>' + inlineToHtml(nd.lines.join('\n'), refs) + '</p>\n';
    case 'heading':
      return '<h' + nd.level + '>' + inlineToHtml(nd.text.trim(), refs) + '</h' + nd.level + '>\n';
    case 'code': {
      let content;
      if (nd.fenced) {
        const fl = nd.lines.slice();
        if (fl.length > 0 && fl[fl.length - 1] === '') fl.pop();
        content = fl.length === 0 ? '' : fl.join('\n') + '\n';
        return '<pre><code' + (nd.lang ? ' class="language-' + escAttrEnt(nd.lang) + '"' : '') + '>' +
          esc(content) + '</code></pre>\n';
      }
      const lines = nd.lines.slice();
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      content = lines.length === 0 ? '' : lines.join('\n') + '\n';
      return '<pre><code>' + esc(content) + '</code></pre>\n';
    }
    case 'html': {
      let out = '';
      for (let i = 0; i < nd.lines.length; i++) {
        const l = nd.lines[i];
        out += l.s;
        if (l.nl && !(i === nd.lines.length - 1 && !nd.nlKept)) out += '\n';
      }
      return out;
    }
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + renderNodes(nd.children, refs) + '</blockquote>\n';
    case 'list': {
      let out = nd.ordered
        ? (nd.start !== 1 ? '<ol start="' + nd.start + '">\n' : '<ol>\n')
        : '<ul>\n';
      for (const item of nd.children) out += renderItem(item, nd.loose, refs);
      out += nd.ordered ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      const alignAttr = a => (a ? ' align="' + a + '"' : '');
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < nd.header.length; i++) {
        out += '<th' + alignAttr(nd.align[i]) + '>' + inlineToHtml(nd.header[i], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (nd.rows.length > 0) {
        out += '<tbody>';
        for (const row of nd.rows) {
          out += '<tr>\n';
          for (let i = 0; i < row.length; i++) {
            out += '<td' + alignAttr(nd.align[i]) + '>' + inlineToHtml(row[i], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
  }
  return '';
}
function renderItem(item, loose, refs) {
  let out = '<li>';
  let first = true;
  for (const ch of item.children) {
    if (ch.t === 'para') {
      const inner = inlineToHtml(ch.lines.join('\n'), refs);
      const box = first && item.task
        ? (item.task === 'checked'
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ')
        : '';
      if (loose) out += '<p>' + box + inner + '</p>\n';
      else out += box + inner;
    } else {
      out += renderNode(ch, refs);
    }
    first = false;
  }
  out += '</li>\n';
  return out;
}

// ---------- entry point ----------
export function parse(markdown) {
  inAnchor = false;
  if (typeof markdown !== 'string') markdown = String(markdown);
  const { doc, refs } = parseBlocks(markdown);
  return renderNodes(doc.children, refs);
}

