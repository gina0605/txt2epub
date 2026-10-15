import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Cover } from './epub';
import { splitLines } from './parse';

interface ManifestItem {
  id: string;
  /** ZIP 안에서의 전체 경로 */
  path: string;
  mediaType: string;
  properties: string[];
  /** OPF에 적힌 원래 태그 문자열 (수정할 때 치환용) */
  raw: string;
}

export interface EpubBook {
  files: Record<string, Uint8Array>;
  opfPath: string;
  opf: string;
  version: string;
  title: string;
  author: string;
  language: string;
  coverItem?: ManifestItem;
  /** 본문을 텍스트 줄로 펼친 것 */
  lines: string[];
  /** 원본 목차에 해당하는 줄 번호 */
  headingLines: number[];
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3]);
  }
  return out;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/** base 디렉터리 기준으로 상대 경로를 ZIP 안의 전체 경로로 바꾼다. #fragment는 버린다. */
export function resolvePath(base: string, href: string): string {
  let decoded = href.split('#')[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 잘못된 % 인코딩은 그대로 사용
  }
  const out: string[] = [];
  for (const part of (base + decoded).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function textOf(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim() : '';
}

/** XHTML 본문을 문단 단위의 텍스트 줄로 바꾼다. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/^[\s\S]*?<body\b[^>]*>/i, '')
      .replace(/<\/body>[\s\S]*$/i, '')
      .replace(/<(script|style|rt|rp)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/\s*[\r\n]+\s*/g, ' ')
      .replace(/<br\b[^>]*>|<hr\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|pre|dt|dd|figcaption)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

function readToc(files: Record<string, Uint8Array>, nav?: ManifestItem, ncx?: ManifestItem) {
  const toc: { path: string; title: string }[] = [];
  if (nav && files[nav.path]) {
    const html = strFromU8(files[nav.path]);
    const block = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(html)?.[1] ?? '';
    for (const m of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = attrs(m[1]).href;
      if (href) toc.push({ path: resolvePath(dirOf(nav.path), href), title: normalize(htmlToText(m[2])) });
    }
  }
  if (!toc.length && ncx && files[ncx.path]) {
    const xml = strFromU8(files[ncx.path]);
    for (const m of xml.matchAll(/<navLabel\b[^>]*>\s*<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)>/gi)) {
      const src = attrs(m[2]).src;
      if (src) toc.push({ path: resolvePath(dirOf(ncx.path), src), title: normalize(decodeEntities(m[1])) });
    }
  }
  return toc;
}

interface PackageInfo {
  opfPath: string;
  opf: string;
  packageTag: string;
  items: Map<string, ManifestItem>;
  all: ManifestItem[];
  /** 스파인 순서의 문서 (manifest에 없는 항목은 뺌) */
  spine: ManifestItem[];
  nav?: ManifestItem;
  ncx?: ManifestItem;
}

function readPackage(files: Record<string, Uint8Array>): PackageInfo {
  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('EPUB 파일이 아니거나 손상되었습니다. (container.xml 없음)');
  const rootfile = /<rootfile\b[^>]*>/i.exec(strFromU8(container));
  const opfPath = rootfile ? attrs(rootfile[0])['full-path'] : '';
  if (!opfPath || !files[opfPath]) throw new Error('EPUB의 OPF 파일을 찾을 수 없습니다.');

  const opf = strFromU8(files[opfPath]);
  const base = dirOf(opfPath);

  const items = new Map<string, ManifestItem>();
  for (const m of opf.matchAll(/<(?:[\w-]+:)?item\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (!a.id || !a.href) continue;
    items.set(a.id, {
      id: a.id,
      path: resolvePath(base, a.href),
      mediaType: a['media-type'] ?? '',
      properties: (a.properties ?? '').split(/\s+/).filter(Boolean),
      raw: m[0],
    });
  }
  const all = [...items.values()];

  const spineTag = /<(?:[\w-]+:)?spine\b[^>]*>/i.exec(opf)?.[0] ?? '';
  const spine = [...opf.matchAll(/<(?:[\w-]+:)?itemref\b[^>]*>/gi)]
    .map((m) => items.get(attrs(m[0]).idref ?? ''))
    .filter((i): i is ManifestItem => i !== undefined);

  return {
    opfPath,
    opf,
    packageTag: /<(?:[\w-]+:)?package\b[^>]*>/i.exec(opf)?.[0] ?? '',
    items,
    all,
    spine,
    nav: all.find((i) => i.properties.includes('nav')),
    ncx: items.get(attrs(spineTag).toc ?? '') ?? all.find((i) => i.mediaType === 'application/x-dtbncx+xml'),
  };
}

/** 스파인에 있는 본문 문서인지 (목차 문서 제외) */
function isContentDoc(files: Record<string, Uint8Array>, pkg: PackageInfo, item: ManifestItem): boolean {
  return item !== pkg.nav && Boolean(files[item.path]) && /x?html/.test(item.mediaType);
}

export interface EpubChapter {
  title: string;
  /** 이 챕터에 속한 본문 문서들의 ZIP 안 경로 (스파인 순서) */
  paths: string[];
}

export interface EpubChapters {
  chapters: EpubChapter[];
  navPath?: string;
  ncxPath?: string;
}

/**
 * 목차를 기준으로 본문 문서를 챕터로 묶는다. 목차 항목이 가리키는 문서부터 다음 항목 전까지가 한 챕터다.
 * 첫 목차 항목 앞의 문서(표지, 속표지 등)는 "목차 앞부분"으로 묶는다.
 * 한 문서 안을 #으로 나눈 목차 항목은 구분하지 못하고 그 문서의 첫 항목에 합친다.
 */
export function readChapters(files: Record<string, Uint8Array>): EpubChapters {
  const pkg = readPackage(files);
  const tocByPath = new Map<string, string>();
  for (const t of readToc(files, pkg.nav, pkg.ncx)) {
    if (!tocByPath.has(t.path)) tocByPath.set(t.path, t.title);
  }

  const chapters: EpubChapter[] = [];
  const seen = new Set<string>();
  for (const item of pkg.spine) {
    if (!isContentDoc(files, pkg, item) || seen.has(item.path)) continue;
    seen.add(item.path);
    const title = tocByPath.get(item.path);
    if (title !== undefined) {
      chapters.push({ title: title || item.path.split('/').pop()!, paths: [item.path] });
    } else if (!tocByPath.size) {
      // 목차가 없으면 문서 하나를 챕터 하나로 본다
      chapters.push({ title: item.path.split('/').pop()!, paths: [item.path] });
    } else if (chapters.length) {
      chapters[chapters.length - 1].paths.push(item.path);
    } else {
      chapters.push({ title: '(목차 앞부분)', paths: [item.path] });
    }
  }
  return { chapters, navPath: pkg.nav?.path, ncxPath: pkg.ncx?.path };
}

export function readEpub(bytes: Uint8Array): EpubBook {
  const files = unzipSync(bytes);
  const pkg = readPackage(files);
  const { opfPath, opf, items, all, nav, ncx } = pkg;

  const coverMetaId = attrs(/<(?:[\w-]+:)?meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opf)?.[0] ?? '').content;
  const coverItem =
    all.find((i) => i.properties.includes('cover-image')) ??
    (coverMetaId ? items.get(coverMetaId) : undefined) ??
    all.find((i) => i.mediaType.startsWith('image/') && /cover/i.test(i.id + i.path));

  const tocByPath = new Map<string, string>();
  for (const t of readToc(files, nav, ncx)) {
    if (t.title && !tocByPath.has(t.path)) tocByPath.set(t.path, t.title);
  }

  // 스파인 순서대로 문서를 텍스트로 펼친다. 목차에 있는 문서의 시작 줄을 챕터 제목으로 표시한다.
  const lines: string[] = [];
  const headingLines: number[] = [];
  for (const item of pkg.spine) {
    if (!isContentDoc(files, pkg, item)) continue;

    const docLines = splitLines(htmlToText(strFromU8(files[item.path])));
    while (docLines.length && !docLines[docLines.length - 1].trim()) docLines.pop();
    const first = docLines.findIndex((l) => l.trim());
    if (first < 0) continue; // 표지 페이지처럼 글자가 없는 문서

    const tocTitle = tocByPath.get(item.path);
    if (tocTitle) {
      // 본문 첫 줄이 목차 제목과 같으면 그 줄을, 아니면 목차 제목을 새 줄로 넣어 챕터 제목으로 쓴다
      if (normalize(docLines[first]) !== tocTitle) docLines.splice(first, 0, tocTitle);
      headingLines.push(lines.length + first);
    }
    lines.push(...docLines, '');
  }

  return {
    files,
    opfPath,
    opf,
    version: attrs(pkg.packageTag).version ?? '2.0',
    title: textOf(opf, 'dc:title'),
    author: textOf(opf, 'dc:creator'),
    language: textOf(opf, 'dc:language') || 'ko',
    coverItem,
    lines,
    headingLines,
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setAttr(tag: string, name: string, value: string | null): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'i');
  const stripped = tag.replace(re, '');
  if (value === null) return stripped;
  return stripped.replace(/\s*(\/?)>$/, ` ${name}="${value}"$1>`);
}

export interface PatchChanges {
  title: string;
  author: string;
  /** undefined: 그대로 / null: 표지 제거 / Cover: 교체 또는 추가 */
  cover?: Cover | null;
}

/** 본문은 그대로 두고 제목, 저자, 표지만 고친 EPUB을 만든다. */
export function patchEpub(book: EpubBook, changes: PatchChanges): Uint8Array {
  const files = { ...book.files };
  let opf = book.opf;
  const isV3 = book.version.startsWith('3');
  const base = dirOf(book.opfPath);

  const title = changes.title.trim();
  if (title && title !== book.title) {
    if (/<dc:title\b[^>]*>[\s\S]*?<\/dc:title>/i.test(opf)) {
      opf = opf.replace(/(<dc:title\b[^>]*>)[\s\S]*?(<\/dc:title>)/i, `$1${xmlEscape(title)}$2`);
    } else {
      opf = opf.replace(/<\/(?:[\w-]+:)?metadata>/i, `<dc:title>${xmlEscape(title)}</dc:title>\n$&`);
    }
  }

  const author = changes.author.trim();
  if (author !== book.author) {
    if (!author) {
      opf = opf.replace(/\s*<dc:creator\b[^>]*>[\s\S]*?<\/dc:creator>/gi, '');
    } else if (/<dc:creator\b[^>]*>[\s\S]*?<\/dc:creator>/i.test(opf)) {
      opf = opf.replace(/(<dc:creator\b[^>]*>)[\s\S]*?(<\/dc:creator>)/i, `$1${xmlEscape(author)}$2`);
    } else {
      opf = opf.replace(/<\/(?:[\w-]+:)?metadata>/i, `<dc:creator>${xmlEscape(author)}</dc:creator>\n$&`);
    }
  }

  if (changes.cover !== undefined) {
    // 기존 표지 지정을 모두 지운다
    opf = opf.replace(/\s*<(?:[\w-]+:)?meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/gi, '');
    for (const m of opf.matchAll(/<(?:[\w-]+:)?item\b[^>]*>/gi)) {
      const props = (attrs(m[0]).properties ?? '').split(/\s+/).filter(Boolean);
      if (props.includes('cover-image')) {
        const rest = props.filter((p) => p !== 'cover-image');
        opf = opf.replace(m[0], setAttr(m[0], 'properties', rest.length ? rest.join(' ') : null));
      }
    }

    const cover = changes.cover;
    if (cover) {
      let coverId: string;
      const existing = book.coverItem;
      if (existing) {
        // 기존 표지 파일을 같은 경로에서 교체하면 표지 페이지 등 기존 참조가 모두 새 이미지를 가리킨다
        coverId = existing.id;
        files[existing.path] = cover.data;
        const tag = new RegExp(`<(?:[\\w-]+:)?item\\b[^>]*\\bid\\s*=\\s*["']${existing.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i').exec(opf)?.[0];
        if (tag) {
          let updated = setAttr(tag, 'media-type', 'image/jpeg');
          if (isV3) {
            const props = (attrs(updated).properties ?? '').split(/\s+/).filter(Boolean);
            updated = setAttr(updated, 'properties', [...props, 'cover-image'].join(' '));
          }
          opf = opf.replace(tag, updated);
        }
      } else {
        coverId = 'txt2epub-cover-image';
        files[`${base}txt2epub-cover.jpg`] = cover.data;
        files[`${base}txt2epub-cover.xhtml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${book.language}">
<head><title>표지</title></head>
<body style="margin:0;padding:0;text-align:center;">
<div style="margin:0;padding:0;height:100%;">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 ${cover.width} ${cover.height}" preserveAspectRatio="xMidYMid meet">
<image width="${cover.width}" height="${cover.height}" xlink:href="txt2epub-cover.jpg"/>
</svg>
</div>
</body>
</html>
`);
        opf = opf.replace(
          /<\/(?:[\w-]+:)?manifest>/i,
          `<item id="${coverId}" href="txt2epub-cover.jpg" media-type="image/jpeg"${isV3 ? ' properties="cover-image"' : ''}/>\n` +
            `<item id="txt2epub-cover" href="txt2epub-cover.xhtml" media-type="application/xhtml+xml"${isV3 ? ' properties="svg"' : ''}/>\n$&`,
        );
        opf = opf.replace(/<(?:[\w-]+:)?spine\b[^>]*>/i, '$&\n<itemref idref="txt2epub-cover"/>');
      }
      opf = opf.replace(/<\/(?:[\w-]+:)?metadata>/i, `<meta name="cover" content="${coverId}"/>\n$&`);
    }
  }

  files[book.opfPath] = strToU8(opf);

  // mimetype은 반드시 ZIP의 첫 번째 파일이어야 하고 압축하지 않아야 한다
  const out: Zippable = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  for (const [path, data] of Object.entries(files)) {
    if (path !== 'mimetype') out[path] = data;
  }
  return zipSync(out, { level: 6 });
}
