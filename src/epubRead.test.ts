import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub } from './epub';
import { htmlToText, isZip, patchEpub, readEpub } from './epubRead';

const jpeg = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), width: 10, height: 15 };

function ownEpub(withCover = false) {
  return buildEpub({
    title: '내 책',
    author: '작가',
    sections: [
      { title: '1화 시작', lines: ['첫 줄', '', '둘째 & 셋째'] },
      { title: '2화 다음', lines: ['본문'] },
    ],
    cover: withCover ? jpeg : undefined,
  });
}

/** 다른 프로그램이 만든 EPUB2 흉내: NCX 목차, 본문에 제목 태그 없음, 하위 폴더 경로 */
function foreignEpub() {
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OPS/book.opf': strToU8(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>외부 &amp; 책</dc:title><dc:language>ko</dc:language></metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="a" href="Text/part%201.html" media-type="application/xhtml+xml"/>
<item id="b" href="Text/part2.html" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="a"/><itemref idref="b"/></spine>
</package>`),
    'OPS/toc.ncx': strToU8(`<ncx><navMap>
<navPoint id="n1"><navLabel><text>제1화 처음</text></navLabel><content src="Text/part%201.html"/></navPoint>
<navPoint id="n2"><navLabel><text>제2화 끝</text></navLabel><content src="Text/part2.html#top"/></navPoint>
</navMap></ncx>`),
    'OPS/Text/part 1.html': strToU8('<html><head><title>x</title></head><body><p>가나다</p>\n<p>제2화 라고 적힌 본문</p></body></html>'),
    'OPS/Text/part2.html': strToU8('<html><body><div>라마<br/>바사</div></body></html>'),
  });
}

describe('htmlToText', () => {
  it('문단과 줄바꿈을 줄로, 엔티티를 문자로 바꾼다', () => {
    expect(htmlToText('<body><p>a &amp; b</p>\n  <p>c<br/>d&#44608;</p><p>&#160;</p></body>')).toBe('a & b\nc\nd김\n\n');
  });
});

describe('readEpub', () => {
  it('이 앱이 만든 EPUB의 목차, 제목, 저자를 읽는다', () => {
    const book = readEpub(ownEpub());
    expect(book.title).toBe('내 책');
    expect(book.author).toBe('작가');
    expect(book.headingLines.map((l) => book.lines[l])).toEqual(['1화 시작', '2화 다음']);
    expect(book.lines).toContain('둘째 & 셋째');
    expect(book.coverItem).toBeUndefined();
  });

  it('EPUB2의 NCX 목차를 읽고, 본문에 없는 목차 제목은 줄로 끼워 넣는다', () => {
    const book = readEpub(foreignEpub());
    expect(book.title).toBe('외부 & 책');
    expect(book.headingLines.map((l) => book.lines[l])).toEqual(['제1화 처음', '제2화 끝']);
    expect(book.lines.filter((l) => l.trim())).toEqual(['제1화 처음', '가나다', '제2화 라고 적힌 본문', '제2화 끝', '라마', '바사']);
  });

  it('ZIP 여부를 판별한다', () => {
    expect(isZip(ownEpub())).toBe(true);
    expect(isZip(strToU8('제목\n본문'))).toBe(false);
  });
});

describe('patchEpub', () => {
  it('표지가 없는 EPUB3에 표지를 추가하고 본문은 그대로 둔다', () => {
    const original = readEpub(ownEpub());
    const patched = patchEpub(original, { title: '내 책', author: '작가', cover: jpeg });
    const files = unzipSync(patched);
    const opf = strFromU8(files['OEBPS/content.opf']);

    expect(strFromU8(patched.subarray(30, 38))).toBe('mimetype');
    expect(files['OEBPS/txt2epub-cover.jpg']).toEqual(jpeg.data);
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="txt2epub-cover-image"/>');
    expect(opf).toMatch(/<spine[^>]*>\n<itemref idref="txt2epub-cover"\/>/);
    expect(files['OEBPS/text/c00001.xhtml']).toEqual(unzipSync(ownEpub())['OEBPS/text/c00001.xhtml']);

    const reread = readEpub(patched);
    expect(reread.coverItem?.path).toBe('OEBPS/txt2epub-cover.jpg');
    // 표지 페이지는 글자가 없으므로 목차·본문 줄에 영향이 없다
    expect(reread.headingLines.map((l) => reread.lines[l])).toEqual(['1화 시작', '2화 다음']);
  });

  it('기존 표지는 같은 경로에서 교체한다', () => {
    const original = readEpub(ownEpub(true));
    const newCover = { data: new Uint8Array([0xff, 0xd8, 1, 2, 3]), width: 20, height: 30 };
    const files = unzipSync(patchEpub(original, { title: '내 책', author: '작가', cover: newCover }));
    expect(files['OEBPS/images/cover.jpg']).toEqual(newCover.data);
    expect(files['OEBPS/txt2epub-cover.jpg']).toBeUndefined();
    const opf = strFromU8(files['OEBPS/content.opf']);
    expect(opf.match(/properties="cover-image"/g)).toHaveLength(1);
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
  });

  it('EPUB2에는 properties 속성 없이 표지를 추가하고 제목·저자를 바꾼다', () => {
    const files = unzipSync(patchEpub(readEpub(foreignEpub()), { title: '새 <제목>', author: '새 작가', cover: jpeg }));
    const opf = strFromU8(files['OPS/book.opf']);
    expect(opf).not.toContain('properties=');
    expect(opf).toContain('<dc:title>새 &lt;제목&gt;</dc:title>');
    expect(opf).toContain('<dc:creator>새 작가</dc:creator>');
    expect(files['OPS/txt2epub-cover.jpg']).toBeDefined();
    expect(files['OPS/Text/part 1.html']).toBeDefined();
  });

  it('표지를 제거하면 표지 지정만 지운다', () => {
    const opf = strFromU8(unzipSync(patchEpub(readEpub(ownEpub(true)), { title: '내 책', author: '작가', cover: null }))['OEBPS/content.opf']);
    expect(opf).not.toContain('properties="cover-image"');
    expect(opf).not.toContain('name="cover"');
  });
});
