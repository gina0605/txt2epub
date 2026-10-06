import { strToU8, zipSync, type Zippable } from 'fflate';
import type { Section } from './parse';

export interface Cover {
  /** JPEG 데이터 */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface EpubInput {
  title: string;
  author?: string;
  language?: string;
  sections: Section[];
  cover?: Cover;
  /** 테스트에서 결과를 고정하기 위한 값 */
  id?: string;
  modified?: Date;
}

// 리더기(특히 구형 기기)는 XHTML 파일 하나가 너무 크면 느려지거나 열지 못한다.
// 한 챕터가 이보다 길면 여러 파일로 나눈다. 한글 기준 약 300KB.
const MAX_CHARS_PER_FILE = 100_000;

// "─┼", "* * *", "◇◆◇" 처럼 기호로만 된 장면 구분 줄
const SCENE_BREAK = /^[─-╿■-◿☀-⛿*\-=~#+·•.\s]+$/;

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderParagraphs(lines: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let pendingBlank = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current.length || chunks.length) pendingBlank = true;
      continue;
    }
    if (size >= MAX_CHARS_PER_FILE) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
      pendingBlank = false;
    }
    if (pendingBlank) {
      current.push('<p class="blank">&#160;</p>');
      pendingBlank = false;
    }
    const cls = line.length <= 20 && SCENE_BREAK.test(line) && !/^[.·•]+$/.test(line) ? ' class="scene"' : '';
    const html = `<p${cls}>${escapeXml(line)}</p>`;
    current.push(html);
    size += html.length;
  }
  if (current.length || !chunks.length) chunks.push(current.join('\n'));
  return chunks;
}

function xhtml(title: string, body: string, lang: string, cssHref = '../style.css'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="${cssHref}"/>
</head>
<body>
${body}
</body>
</html>
`;
}

const STYLE = `body { margin: 0; padding: 0 0.5em; line-height: 1.8; word-break: keep-all; }
h2 { font-size: 1.3em; margin: 2em 0 1.5em; line-height: 1.4; }
p { margin: 0; }
p.blank { height: 1em; }
p.scene { text-align: center; margin: 1em 0; }
nav ol { list-style: none; padding-left: 0; }
nav li { margin: 0.4em 0; }
`;

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function buildEpub(input: EpubInput): Uint8Array {
  const lang = input.language ?? 'ko';
  const title = input.title.trim() || '제목 없음';
  const author = input.author?.trim();
  const id = `urn:uuid:${input.id ?? uuid()}`;
  const modified = (input.modified ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');

  const files: Zippable = {
    // mimetype은 반드시 ZIP의 첫 번째 파일이어야 하고 압축하지 않아야 한다
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>
`),
    'OEBPS/style.css': strToU8(STYLE),
  };

  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
  ];
  const spine: string[] = [];

  if (input.cover) {
    const { width, height } = input.cover;
    files['OEBPS/images/cover.jpg'] = input.cover.data;
    files['OEBPS/cover.xhtml'] = strToU8(
      xhtml(
        '표지',
        `<div style="margin:0;padding:0;text-align:center;height:100%;">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
<image width="${width}" height="${height}" xlink:href="images/cover.jpg"/>
</svg>
</div>`,
        lang,
        'style.css',
      ),
    );
    manifest.push(
      '<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
      '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" properties="svg"/>',
    );
    spine.push('<itemref idref="cover"/>');
  }

  const toc: { title: string; href: string }[] = [];
  input.sections.forEach((section, i) => {
    const base = `c${String(i + 1).padStart(5, '0')}`;
    renderParagraphs(section.lines).forEach((chunk, part) => {
      const name = part === 0 ? base : `${base}_${part + 1}`;
      const heading = part === 0 ? `<h2>${escapeXml(section.title)}</h2>\n` : '';
      files[`OEBPS/text/${name}.xhtml`] = strToU8(
        xhtml(section.title, `<section epub:type="chapter">\n${heading}${chunk}\n</section>`, lang),
      );
      manifest.push(`<item id="${name}" href="text/${name}.xhtml" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="${name}"/>`);
    });
    toc.push({ title: section.title, href: `text/${base}.xhtml` });
  });

  files['OEBPS/nav.xhtml'] = strToU8(
    xhtml(
      '목차',
      `<nav epub:type="toc" id="toc">
<h2>목차</h2>
<ol>
${toc.map((t) => `<li><a href="${t.href}">${escapeXml(t.title)}</a></li>`).join('\n')}
</ol>
</nav>`,
      lang,
      'style.css',
    ),
  );

  // EPUB2 리더기 호환용 목차
  files['OEBPS/toc.ncx'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="${id}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${toc
  .map(
    (t, i) =>
      `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(t.title)}</text></navLabel><content src="${t.href}"/></navPoint>`,
  )
  .join('\n')}
</navMap>
</ncx>
`);

  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
${author ? `<dc:creator>${escapeXml(author)}</dc:creator>\n` : ''}<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
${input.cover ? '<meta name="cover" content="cover-image"/>\n' : ''}</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
${input.cover ? '<guide>\n<reference type="cover" title="표지" href="cover.xhtml"/>\n</guide>\n' : ''}</package>
`);

  return zipSync(files, { level: 6 });
}
