import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub } from '../epub';
import { readChapters } from '../epubRead';
import {
  applyToEpubFiles,
  applyToMarkup,
  applyToText,
  buildRegExp,
  compileRule,
  emptyResults,
  normalizeNewlines,
  regexError,
  unescapeReplacement,
  zipEpub,
  type RuleSpec,
} from './substitute';

function run(text: string, ...specs: RuleSpec[]) {
  const results = emptyResults(specs.length);
  return { text: applyToText(text, specs.map(compileRule), results), results };
}

const rule = (find: string, replace: string, flags = ''): RuleSpec => ({ find, replace, flags });

describe('치환 문자열', () => {
  // 직접 구현한 $ 해석이 브라우저의 String.prototype.replace와 같은 결과를 내는지 확인한다
  const cases: [string, string, string][] = [
    ['(\\w+)@(\\w+)', '$2:$1', 'a@b c@d'],
    ['(a)(b)?', '[$1|$2]', 'a ab'],
    ['x', '$$-$&-$`-$\'', '1x2'],
    ['(\\d)', '$0 $10 $01 $9', '7'],
    ['(?<y>\\d{4})-(?<m>\\d\\d)', '$<m>/$<y> $<none> $<y', '2024-05'],
    ['(a)', '$<x>', 'a'],
    ['(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)', '$11 $10 $1', 'abcdefghijk'],
    ['', '-', 'ab'],
    ['^', '> ', '줄1\n줄2'],
    ['b*', 'X', 'abba'],
  ];
  it.each(cases)('%s → %s', (find, replace, input) => {
    const expected = input.replace(buildRegExp(find, ''), replace);
    expect(run(input, rule(find, replace)).text).toBe(expected);
  });

  it('\\n, \\t, \\\\를 실제 문자로 바꾼다', () => {
    expect(unescapeReplacement('a\\nb\\tc\\\\n\\d')).toBe('a\nb\tc\\n\\d');
    expect(run('가.나', rule('\\.', '\\n')).text).toBe('가\n나');
  });
});

describe('텍스트 적용', () => {
  it('규칙을 위에서부터 차례로 적용한다', () => {
    expect(run('사과', rule('사과', '배'), rule('배', '감')).text).toBe('감');
  });

  it('^와 $는 줄 단위로 매치한다', () => {
    expect(run('a\nb', rule('^', '- ')).text).toBe('- a\n- b');
  });

  it('i, s 플래그를 쓸 수 있다', () => {
    expect(run('ABC', rule('b', 'x', 'i')).text).toBe('AxC');
    expect(run('a\nb', rule('a.b', 'x', 's')).text).toBe('x');
    expect(run('a\nb', rule('a.b', 'x')).text).toBe('a\nb');
  });

  it('매치 수와 예시를 모은다', () => {
    const { results } = run('하나 둘 셋 둘', rule('둘', '2'), rule('없음', ''));
    expect(results[0].count).toBe(2);
    expect(results[0].samples[0]).toEqual({ before: '하나 ', match: '둘', replacement: '2', after: ' 셋 둘' });
    expect(results[1].count).toBe(0);
  });

  it('CRLF를 LF로 바꾼다', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toEqual({ text: 'a\nb\nc', crlf: true });
    expect(normalizeNewlines('a\nb')).toEqual({ text: 'a\nb', crlf: false });
  });

  it('잘못된 정규식을 알려준다', () => {
    expect(regexError('(', '')).toBeTruthy();
    expect(regexError('', '')).toBeTruthy();
    expect(regexError('a+', 'i')).toBeNull();
  });

  it('수십 MB 텍스트도 처리한다', () => {
    const big = '가나다라마바사 아자차카타파하.\n'.repeat(1_000_000);
    const { text, results } = run(big, rule('가나', 'XY'), rule('\\.$', '!'));
    expect(results[0].count).toBe(1_000_000);
    expect(results[1].count).toBe(1_000_000);
    expect(results[0].samples.length).toBe(30);
    expect(text.length).toBe(big.length);
    expect(text.startsWith('XY다라마바사 아자차카타파하!\n')).toBe(true);
  });
});

describe('XHTML 적용', () => {
  const apply = (src: string, ...specs: RuleSpec[]) =>
    applyToMarkup(src, 'html', specs.map(compileRule), emptyResults(specs.length));

  it('본문 글자만 바꾸고 태그, 속성, head는 그대로 둔다', () => {
    const src =
      '<html><head><title>p 제목</title><style>p { color: red }</style></head>' +
      '<body class="p"><p id="p1">p 본문</p><script>var p = 1;</script></body></html>';
    expect(apply(src, rule('p', 'q'))).toBe(
      '<html><head><title>p 제목</title><style>p { color: red }</style></head>' +
        '<body class="p"><p id="p1">q 본문</p><script>var p = 1;</script></body></html>',
    );
  });

  it('엔티티를 풀어서 찾고, 바꾼 글자는 다시 이스케이프한다', () => {
    expect(apply('<body><p>A &amp; B&#160;C</p></body>', rule('&', '<와>'))).toBe('<body><p>A &lt;와&gt; B\u00a0C</p></body>');
    // 바뀌지 않은 글자는 원래 표기를 유지한다
    expect(apply('<body><p>A &amp; B</p></body>', rule('없음', ''))).toBe('<body><p>A &amp; B</p></body>');
  });

  it('주석과 CDATA는 건드리지 않는다', () => {
    expect(apply('<body><!-- a --><p>a</p></body>', rule('a', 'b'))).toBe('<body><!-- a --><p>b</p></body>');
  });

  it('NCX는 <text> 안만 바꾼다', () => {
    const src = '<ncx><navLabel><text>1화 a</text></navLabel><content src="a.xhtml"/></ncx>';
    expect(applyToMarkup(src, 'ncx', [compileRule(rule('a', 'b'))], emptyResults(1))).toBe(
      '<ncx><navLabel><text>1화 b</text></navLabel><content src="a.xhtml"/></ncx>',
    );
  });
});

describe('EPUB 적용', () => {
  it('본문과 목차를 바꾸고 나머지 파일은 유지한다', () => {
    const epub = buildEpub({
      title: '책',
      sections: [{ title: '1화 철수', lines: ['철수가 왔다.', '철수 & 영희'] }],
      cover: { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), width: 1, height: 1 },
    });
    const files = unzipSync(epub);
    const results = emptyResults(1);
    const out = unzipSync(zipEpub(applyToEpubFiles(files, [compileRule(rule('철수', '민수'))], results)));

    expect(Object.keys(out)[0]).toBe('mimetype');
    expect(strFromU8(out['OEBPS/text/c00001.xhtml'])).toContain('<p>민수가 왔다.</p>');
    expect(strFromU8(out['OEBPS/text/c00001.xhtml'])).toContain('<p>민수 &amp; 영희</p>');
    expect(strFromU8(out['OEBPS/text/c00001.xhtml'])).toContain('<title>1화 철수</title>');
    expect(strFromU8(out['OEBPS/toc.ncx'])).toContain('<text>1화 민수</text>');
    expect(strFromU8(out['OEBPS/content.opf'])).toBe(strFromU8(files['OEBPS/content.opf']));
    expect(out['OEBPS/images/cover.jpg']).toEqual(files['OEBPS/images/cover.jpg']);
    // 본문 h2, 본문 2줄, 목차(nav), NCX
    expect(results[0].count).toBe(5);
  });

  it('바뀌지 않은 파일은 같은 데이터를 쓴다', () => {
    const files = { 'a.xhtml': strToU8('<body>x</body>'), 'b.css': strToU8('x') };
    const out = applyToEpubFiles(files, [compileRule(rule('y', 'z'))], emptyResults(1));
    expect(out['a.xhtml']).toBe(files['a.xhtml']);
  });
});

describe('챕터 하나에만 적용', () => {
  const epub = () =>
    unzipSync(
      buildEpub({
        title: '철수 이야기',
        sections: [
          { title: '1화 철수', lines: ['철수가 왔다.'] },
          { title: '2화 철수', lines: ['철수가 갔다.'] },
        ],
      }),
    );

  it('그 챕터의 본문과 목차 항목만 바꾼다', () => {
    const files = epub();
    const { chapters, navPath, ncxPath } = readChapters(files);
    const results = emptyResults(1);
    const out = applyToEpubFiles(files, [compileRule(rule('철수', '민수'))], results, undefined, {
      paths: chapters[1].paths,
      navPath,
      ncxPath,
    });
    const text = (p: string) => strFromU8(out[p]);

    expect(text('OEBPS/text/c00001.xhtml')).toContain('<p>철수가 왔다.</p>');
    expect(text('OEBPS/text/c00002.xhtml')).toContain('<h2>2화 민수</h2>');
    expect(text('OEBPS/text/c00002.xhtml')).toContain('<p>민수가 갔다.</p>');
    expect(text('OEBPS/nav.xhtml')).toContain('<a href="text/c00001.xhtml">1화 철수</a>');
    expect(text('OEBPS/nav.xhtml')).toContain('<a href="text/c00002.xhtml">2화 민수</a>');
    expect(text('OEBPS/toc.ncx')).toContain('<docTitle><text>철수 이야기</text></docTitle>');
    expect(text('OEBPS/toc.ncx')).toContain('<text>1화 철수</text>');
    expect(text('OEBPS/toc.ncx')).toContain('<text>2화 민수</text>');
    // 본문 h2, 본문 1줄, nav, ncx
    expect(results[0].count).toBe(4);
  });

  it('중첩된 navPoint는 각자 가리키는 경로로 판단한다', () => {
    const ncx =
      '<ncx><docTitle><text>a</text></docTitle><navMap>' +
      '<navPoint><navLabel><text>a 1부</text></navLabel><content src="t/p1.xhtml"/>' +
      '<navPoint><navLabel><text>a 1화</text></navLabel><content src="t/c1.xhtml#x"/></navPoint>' +
      '<navPoint><navLabel><text>a 2화</text></navLabel><content src="t/c2.xhtml"/></navPoint>' +
      '</navPoint></navMap></ncx>';
    const out = applyToMarkup(ncx, 'ncx', [compileRule(rule('a', 'b'))], emptyResults(1), {
      targets: new Set(['OPS/t/c1.xhtml']),
      base: 'OPS/',
    });
    expect(out).toContain('<docTitle><text>a</text>');
    expect(out).toContain('<text>a 1부</text>');
    expect(out).toContain('<text>b 1화</text>');
    expect(out).toContain('<text>a 2화</text>');
  });
});
