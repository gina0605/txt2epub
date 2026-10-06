import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub } from './epub';

const sections = [
  { title: '1화 <시작> & 끝', lines: ['', '첫 줄', '', '', '둘째 줄', '─┼', '셋째'] },
  { title: '2화', lines: ['본문'] },
];

describe('buildEpub', () => {
  const epub = buildEpub({
    title: '테스트 책',
    author: '작가',
    sections,
    cover: { data: new Uint8Array([0xff, 0xd8, 0xff]), width: 100, height: 150 },
    id: '00000000-0000-4000-8000-000000000000',
    modified: new Date('2026-01-01T00:00:00.123Z'),
  });
  const files = unzipSync(epub);

  it('mimetype이 첫 번째 파일이며 압축되지 않았다', () => {
    // ZIP 로컬 헤더: 압축 방식(offset 8) = 0, 파일 이름(offset 30) = mimetype
    expect(epub[8]).toBe(0);
    expect(strFromU8(epub.subarray(30, 38))).toBe('mimetype');
    expect(strFromU8(epub.subarray(38, 58))).toBe('application/epub+zip');
  });

  it('표지를 EPUB2/3 방식으로 모두 지정한다', () => {
    const opf = strFromU8(files['OEBPS/content.opf']);
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
    expect(opf).toContain('<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>');
    expect(files['OEBPS/images/cover.jpg']).toBeDefined();
  });

  it('본문을 이스케이프하고 빈 줄과 장면 구분을 표시한다', () => {
    const ch1 = strFromU8(files['OEBPS/text/c00001.xhtml']);
    expect(ch1).toContain('<h2>1화 &lt;시작&gt; &amp; 끝</h2>');
    expect(ch1).toContain('<p>첫 줄</p>\n<p class="blank">&#160;</p>\n<p>둘째 줄</p>\n<p class="scene">─┼</p>');
  });

  it('목차에 모든 챕터가 들어간다', () => {
    const nav = strFromU8(files['OEBPS/nav.xhtml']);
    expect(nav).toContain('<a href="text/c00002.xhtml">2화</a>');
    expect(strFromU8(files['OEBPS/toc.ncx'])).toContain('playOrder="2"');
  });

  it('긴 챕터는 여러 파일로 나눈다', () => {
    const long = Array.from({ length: 20_000 }, (_, i) => `문장 ${i}`);
    const out = unzipSync(buildEpub({ title: 't', sections: [{ title: '1화', lines: long }] }));
    const parts = Object.keys(out).filter((k) => k.startsWith('OEBPS/text/'));
    expect(parts.length).toBeGreaterThan(1);
    expect(strFromU8(out['OEBPS/nav.xhtml']).match(/<li>/g)).toHaveLength(1);
  });
});
