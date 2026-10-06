import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decode } from './decode';
import { buildSections, detectChapters, findTitle, splitLines } from './parse';

function detect(text: string) {
  const lines = splitLines(text);
  const { title, bodyStart } = findTitle(lines);
  const candidates = detectChapters(lines, bodyStart);
  return { title, lines, bodyStart, candidates, accepted: candidates.filter((c) => c.accepted).map((c) => c.text) };
}

// 예시 소설 파일은 저작권 때문에 저장소에 올리지 않으므로, 로컬에 있을 때만 테스트한다
const EXAMPLE = new URL('../examples/pa.TXT', import.meta.url);

describe.skipIf(!existsSync(EXAMPLE))('examples/pa.TXT', () => {
  let result: ReturnType<typeof detect>;
  beforeAll(() => {
    result = detect(decode(new Uint8Array(readFileSync(EXAMPLE))).text);
  });

  it('첫 줄을 제목으로 읽는다', () => {
    expect(result.title).toBe('삼국지 - 내가 영웅의 그릇인가');
  });

  it('숫자만 있는 챕터 제목을 찾고 폭 없는 문자를 제거한다', () => {
    expect(result.accepted).toEqual([
      '001 요즘은 항상 같은 생각을 한다.',
      '002 제가 그 사람입니다',
      '003 장래희망은 공무원입니다.',
      '004 이 사람들 큰일 났을 뻔.',
      '005 대단한 인격자를 얻은 것일지도',
    ]);
  });

  it('챕터별로 본문을 나눈다', () => {
    const sections = buildSections(
      result.lines,
      result.bodyStart,
      result.candidates.filter((c) => c.accepted).map((c) => c.line),
      result.title,
    );
    expect(sections).toHaveLength(5);
    expect(sections[0].lines.find((l) => l.trim())).toBe('때는 대충 2,000년 정도 전의 중국!');
  });
});

describe('detectChapters', () => {
  it('제N화 + 제목', () => {
    const r = detect('책\n\n제1화 시작\n본문\n제2화 다음\n본문\n제3화\n본문');
    expect(r.accepted).toEqual(['제1화 시작', '제2화 다음', '제3화']);
  });

  it('N화', () => {
    const r = detect('책\n1화\n본문\n2화 - 제목\n본문\n3화\n본문');
    expect(r.accepted).toEqual(['1화', '2화 - 제목', '3화']);
  });

  it('본문 속 숫자로 시작하는 줄은 번호 순서가 맞지 않으면 제외한다', () => {
    const r = detect(
      '책\n\n1화\n\n3 년이 지났다.\n1일, 2일, 3일\n\n2화\n\n10 명이 왔다.\n\n3화\n\n본문\n\n4화\n\n2 번째 이야기',
    );
    expect(r.accepted).toEqual(['1화', '2화', '3화', '4화']);
    expect(r.candidates.filter((c) => !c.accepted).map((c) => c.text)).toEqual([
      '3 년이 지났다.',
      '10 명이 왔다.',
      '2 번째 이야기',
    ]);
  });

  it('중간에 빠진 화가 있어도 이어서 인식한다', () => {
    const r = detect('책\n1화\na\n2화\nb\n4화\nc\n5화\nd');
    expect(r.accepted).toEqual(['1화', '2화', '4화', '5화']);
  });

  it('프롤로그, 외전처럼 번호 없는 챕터도 인식한다', () => {
    const r = detect('책\n프롤로그\na\n1화\nb\n2화\nc\n외전 1화\nd');
    expect(r.accepted).toEqual(['프롤로그', '1화', '2화', '외전 1화']);
  });

  it('권이 바뀌어 번호가 1부터 다시 시작해도 인식한다', () => {
    const r = detect('책\n1화\na\n2화\nb\n3화\nc\n1화\nd\n2화\ne');
    expect(r.accepted).toHaveLength(5);
  });

  it('챕터가 없으면 아무것도 채택하지 않는다', () => {
    const r = detect('책\n그냥 본문이다.\n3 년이 지났다.\n또 본문.');
    expect(r.accepted).toEqual([]);
  });
});

describe('decode', () => {
  it('EUC-KR 파일을 감지한다', () => {
    // "가나다" in EUC-KR
    const bytes = new Uint8Array([0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9]);
    expect(decode(bytes)).toEqual({ text: '가나다', encoding: 'euc-kr' });
  });
});
