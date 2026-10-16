// Wikipedia in the reader, by section. Wikipedia's own API is open to web pages, so an article can be read without
// Jina Reader: the opening section loads first (with the list of sections), and each further section loads only when
// asked. Tables arrive as tables. The API sends HTML; a small reader below turns the useful parts into the Markdown
// the app already knows how to show.

const HOST_RE = /^([a-z0-9-]+?)(?:\.m)?\.wikipedia\.org$/i;

/** https://en.wikipedia.org/wiki/Mount_Fuji → { host: 'en.wikipedia.org', title: 'Mount Fuji' }, or null. */
export function wikiTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const m = HOST_RE.exec(u.hostname);
  if (!m || u.protocol !== 'https:') return null;
  let title = '';
  if (u.pathname.startsWith('/wiki/')) {
    try {
      title = decodeURIComponent(u.pathname.slice(6));
    } catch {
      return null;
    }
  } else if (u.pathname === '/w/index.php' && u.searchParams.get('title')) title = u.searchParams.get('title');
  title = title.replace(/_/g, ' ').trim();
  if (!title || /^(special|media):/i.test(title) || title.length > 250) return null;
  return { host: `${m[1].toLowerCase()}.wikipedia.org`, title };
}

const API = (host, params) =>
  `https://${host}/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', redirects: '1', ...params })}`;

/** The opening section as HTML. */
export const leadUrl = (host, title) =>
  API(host, { action: 'parse', page: title, prop: 'text|displaytitle', section: '0', disableeditsection: '1', disablelimitreport: '1', disabletoc: '1' });

/** The list of sections only (no text). */
export const tocUrl = (host, title) => API(host, { action: 'parse', page: title, prop: 'tocdata' });

/** One section (and its subsections) as HTML. */
export const sectionUrl = (host, title, index) =>
  API(host, { action: 'parse', page: title, prop: 'text', section: String(index), disableeditsection: '1', disablelimitreport: '1', disabletoc: '1' });

/** The whole article as HTML. */
export const fullUrl = (host, title) =>
  API(host, { action: 'parse', page: title, prop: 'text|displaytitle', disableeditsection: '1', disablelimitreport: '1', disabletoc: '1' });

export const canonicalUrl = (host, title) => `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':')}`;

/** An API error body → its message, or ''. */
export function apiError(json) {
  const e = json?.error;
  return e ? String(e.info || e.code || 'error').slice(0, 200) : '';
}

const SKIP_SECTIONS = /^(references|notes|footnotes|citations|external links|further reading|bibliography|sources|works cited|see also|notes and references|references and notes)$/i;

/**
 * Top-level sections to offer: [{ index, line, anchor }]. A top-level section loads together with its subsections,
 * so those are only counted. Reference-style sections are left out.
 */
export function parseToc(json) {
  const all = json?.parse?.tocdata?.sections;
  if (!Array.isArray(all)) return [];
  const out = [];
  for (const s of all) {
    const level = Number(s.tocLevel ?? s.toclevel);
    if (level === 1) out.push({ index: Number(s.index), line: stripTags(String(s.line ?? '')), anchor: String(s.anchor ?? ''), subs: 0 });
    else if (out.length) out[out.length - 1].subs++;
  }
  return out.filter((s) => Number.isFinite(s.index) && s.line && !SKIP_SECTIONS.test(s.line));
}

/** The HTML text of a parse response, and its title. */
export function parseBody(json) {
  const p = json?.parse;
  return { html: typeof p?.text === 'string' ? p.text : '', title: stripTags(String(p?.displaytitle ?? p?.title ?? '')) || String(p?.title ?? '') };
}

// ---------- HTML → Markdown ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', minus: '−', times: '×', thinsp: ' ', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', deg: '°', middot: '·' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s) => decode(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

const VOID = new Set(['br', 'img', 'hr', 'link', 'meta', 'wbr', 'input', 'source', 'col']);
// Whole elements whose content is dropped.
const DROP_TAGS = new Set(['style', 'script', 'figure', 'img', 'link', 'meta', 'math', 'audio', 'video', 'form', 'button', 'noscript', 'svg']);
const DROP_CLASS =
  /(^|\s)(mw-editsection|navbox|navbox-styles|vertical-navbox|hatnote|shortdescription|metadata|ambox|mw-empty-elt|reflist|refbegin|references|mw-references-wrap|toc|thumb|tright|tleft|gallery|noprint|catlinks|printfooter|sistersitebox|side-box|portal|mw-cite-backlink|reference|mwe-math-element|sidebar|mbox-small|stub|navigation-not-searchable|plainlinks-print|authority-control|mw-authority-control|geo-nondefault|mw-jump-link|mw-ext-cite-error|cite-error|error)(\s|$)/;

/** Minimal tree from well-formed HTML: { tag, attrs: {class, href, …}, kids } | string. */
function parseHtml(html) {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, '');
  const root = { tag: 'root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const top = stack[stack.length - 1];
    if (m[4] != null) {
      top.kids.push(m[4]);
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const el = { tag, attrs, kids: [] };
    top.kids.push(el);
    if (!VOID.has(tag) && !m[3].trimEnd().endsWith('/')) stack.push(el);
  }
  return root;
}

const dropped = (el) =>
  DROP_TAGS.has(el.tag) ||
  (el.attrs.class && DROP_CLASS.test(el.attrs.class)) ||
  el.attrs.role === 'note' ||
  el.attrs.style?.includes('display:none') ||
  el.attrs.hidden != null;

const text = (el) => (typeof el === 'string' ? decode(el) : dropped(el) ? '' : el.tag === 'br' ? ' ' : el.kids.map(text).join(''));

function linkTarget(href, host) {
  if (!href || href.startsWith('#')) return null;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/wiki/')) {
    if (/^\/wiki\/(File|Image|Media|Special|Category|Help|Wikipedia|Template|Talk):/i.test(href)) return null;
    return `https://${host}${href}`.replace(/\(/g, '%28').replace(/\)/g, '%29');
  }
  if (href.startsWith('/w/index.php')) return null;
  if (/^https?:\/\//i.test(href)) return href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return null;
}

const esc = (s) => s.replace(/([\\`*_[\]|])/g, '\\$1');

function inline(el, host) {
  if (typeof el === 'string') return esc(decode(el).replace(/\s+/g, ' '));
  if (dropped(el)) return '';
  const inner = () => el.kids.map((k) => inline(k, host)).join('');
  switch (el.tag) {
    case 'br':
      return ' ';
    case 'b':
    case 'strong': {
      const t = inner();
      return t.trim() ? `**${t.trim()}** ` : t;
    }
    case 'i':
    case 'em': {
      const t = inner();
      return t.trim() ? `*${t.trim()}* ` : t;
    }
    case 'a': {
      const t = inner().trim();
      const target = linkTarget(el.attrs.href, host);
      return t && target ? `[${t}](${target})` : t;
    }
    case 'sup': {
      const t = text(el).trim();
      return t ? `^${t}` : '';
    }
    case 'ul':
    case 'ol':
      return el.kids
        .filter((k) => typeof k !== 'string' && k.tag === 'li' && !dropped(k))
        .map((k) => inline(k, host).trim())
        .filter(Boolean)
        .join(', ');
    case 'div':
      return `${inner()} `;
    case 'sub':
      return text(el).trim();
    case 'code':
    case 'kbd':
    case 'samp': {
      const t = text(el);
      return t.trim() ? `\`${t.replace(/`/g, "'")}\`` : '';
    }
    default:
      return inner();
  }
}

const tidy = (s) =>
  s
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .replace(/\*\*\s+(?=\w)/g, '** ')
    .trim();

const childTags = (el, tag) => el.kids.filter((k) => typeof k !== 'string' && k.tag === tag && !dropped(k));

function tableRows(table, host) {
  const rows = [];
  const visit = (node) => {
    for (const k of node.kids) {
      if (typeof k === 'string' || dropped(k)) continue;
      if (k.tag === 'tr') {
        const cells = k.kids.filter((c) => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th') && !dropped(c));
        if (cells.length) rows.push(cells.map((c) => tidy(inline(c, host)).replace(/\\?\|/g, '/')));
      } else if (['thead', 'tbody', 'tfoot'].includes(k.tag)) visit(k);
    }
  };
  visit(table);
  return rows;
}

function tableMarkdown(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const lines = rows.map((r) => `| ${pad(r).join(' | ')} |`);
  lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return lines.join('\n');
}

/** HTML from the Wikipedia API → Markdown. `host` makes /wiki/ links absolute. */
export function htmlToMarkdown(html, host = 'en.wikipedia.org') {
  const out = [];
  let held = ''; // the infobox waits until the first paragraph has been shown, as on Wikipedia's phone layout
  const push = (s) => {
    if (s) out.push(s);
  };

  const list = (el, depth) => {
    const ordered = el.tag === 'ol';
    let n = 0;
    for (const li of childTags(el, 'li')) {
      n++;
      const own = li.kids.filter((k) => typeof k === 'string' || !['ul', 'ol'].includes(k.tag));
      const line = tidy(own.map((k) => inline(k, host)).join(''));
      if (line) push(`${'  '.repeat(depth)}${ordered ? `${n}.` : '-'} ${line}`);
      for (const sub of li.kids) if (typeof sub !== 'string' && ['ul', 'ol'].includes(sub.tag) && !dropped(sub)) list(sub, depth + 1);
    }
  };

  const infobox = (el) => {
    const rows = [];
    for (const tr of el.kids.flatMap((k) => (typeof k !== 'string' && ['tbody', 'thead'].includes(k.tag) ? k.kids : [k]))) {
      if (typeof tr === 'string' || tr.tag !== 'tr') continue;
      const th = childTags(tr, 'th')[0];
      const td = childTags(tr, 'td')[0];
      if (th && td) rows.push([tidy(inline(th, host)), tidy(inline(td, host))]);
    }
    if (rows.length) held = tableMarkdown([['Quick facts', ''], ...rows.slice(0, 16)]);
  };

  const walk = (node) => {
    if (typeof node === 'string') {
      const t = decode(node).trim();
      if (t) push(esc(t));
      return;
    }
    if (dropped(node)) {
      return;
    }
    const cls = node.attrs.class ?? '';
    switch (node.tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const t = tidy(text(node));
        if (t) push(`${'#'.repeat(Math.max(1, Number(node.tag[1]) - 1))} ${t}`);
        return;
      }
      case 'p': {
        const t = tidy(node.kids.map((k) => inline(k, host)).join(''));
        if (t) {
          push(t);
          if (held) {
            push(held);
            held = '';
          }
        }
        return;
      }
      case 'ul':
      case 'ol':
        list(node, 0);
        out.push('');
        return;
      case 'dl':
        for (const k of node.kids) if (typeof k !== 'string' && (k.tag === 'dt' || k.tag === 'dd') && !dropped(k)) push(tidy(inline(k, host)));
        return;
      case 'blockquote': {
        const t = tidy(node.kids.map((k) => inline(k, host)).join(''));
        if (t) push(`> ${t}`);
        return;
      }
      case 'pre': {
        const t = text(node).replace(/\s+$/, '');
        if (t) push(`\`\`\`\n${t}\n\`\`\``);
        return;
      }
      case 'table': {
        if (/infobox/.test(cls)) return infobox(node);
        if (!/wikitable|sortable|data|table/.test(cls)) return;
        const rows = tableRows(node, host);
        const cap = childTags(node, 'caption')[0];
        if (cap) push(`**${tidy(text(cap))}**`);
        if (rows.length) push(tableMarkdown(rows));
        return;
      }
      default:
        for (const k of node.kids) walk(k);
    }
  };

  walk(parseHtml(html));
  push(held);
  // Blank line between blocks so the Markdown reader keeps them apart (list items and table rows stay together).
  const lines = [];
  for (const s of out) {
    const joins = (l) => /^\s*(?:[-]|\d+\.)\s/.test(l) && !/^\s*-\s*$/.test(l);
    const prev = lines[lines.length - 1];
    if (s === '') {
      if (prev !== '') lines.push('');
      continue;
    }
    if (prev !== undefined && prev !== '' && !(joins(prev) && joins(s))) lines.push('');
    lines.push(s);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
