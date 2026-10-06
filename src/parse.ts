export interface Candidate {
  /** 0부터 시작하는 줄 번호 */
  line: number;
  text: string;
  /** 챕터 번호. 프롤로그처럼 번호가 없는 챕터는 null */
  num: number | null;
  /** 자동 인식 결과 챕터로 채택되었는지 */
  accepted: boolean;
  /** EPUB 입력에서, 원본 목차와 별개로 자동 인식이 챕터로 판단했는지 */
  auto?: boolean;
}

export interface Section {
  title: string;
  lines: string[];
}

// 웹소설 사이트에서 복사할 때 섞여 들어오는 폭 없는 문자와, XML에서 허용되지 않는 제어 문자
const INVISIBLE = /[​-‍⁠﻿]/g;
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const MAX_HEADING_LENGTH = 100;
// 챕터 번호가 이 값 이하로 건너뛰는 것까지는 연속으로 본다 (중간 화가 빠진 파일 대응)
const MAX_GAP = 3;

const OPEN = '[\\[(<【〈《「『]';
const CLOSE = '[\\])>】〉》」』]';
// 제12화 / 12화 / 012 / [12화] / Chapter 12 등 + 뒤에 오는 챕터 제목
const NUMBERED = new RegExp(
  `^(${OPEN})?\\s*(제\\s*)?(chapter|ch\\.|ep\\.|episode)?\\s*(\\d{1,5})\\s*(화|장|회|편)?\\s*(${CLOSE})?(?:[\\s.:\\-–—]+(.*))?$`,
  'i',
);
const NAMED = new RegExp(
  `^(${OPEN})?\\s*(프롤로그|에필로그|prologue|epilogue|외전|번외|후기|작가\\s*후기|서장|종장)`,
  'i',
);

export function splitLines(text: string): string[] {
  return text.replace(INVISIBLE, '').replace(XML_INVALID, '').split(/\r\n|\r|\n/);
}

/** 첫 번째로 내용이 있는 줄을 책 제목으로 본다. 본문은 그 다음 줄부터. */
export function findTitle(lines: string[]): { title: string; bodyStart: number } {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t) return { title: t, bodyStart: i + 1 };
  }
  return { title: '', bodyStart: 0 };
}

interface NumberedMatch {
  line: number;
  text: string;
  num: number;
  style: string;
  strong: boolean;
  score: number;
}

/**
 * 챕터 제목 줄을 자동으로 찾는다.
 *
 * 1. 형식에 맞는 줄을 모두 후보로 모은다.
 * 2. 본문 중 "3 년 후" 같은 줄도 후보에 섞이므로, 번호가 차례로 이어지는
 *    가장 그럴듯한 사슬만 챕터로 채택한다. 가장 흔한 형식(제N화, N화, 숫자만 등)과
 *    같은 형식이거나 앞뒤에 빈 줄이 있는 후보를 더 높게 친다.
 */
export function detectChapters(lines: string[], bodyStart: number): Candidate[] {
  const numbered: NumberedMatch[] = [];
  const named: Candidate[] = [];

  for (let i = bodyStart; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text || text.length > MAX_HEADING_LENGTH) continue;

    const m = NUMBERED.exec(text);
    if (m) {
      const [, open, je, word, digits, suffix, close] = m;
      numbered.push({
        line: i,
        text,
        num: parseInt(digits, 10),
        style: `${open || close ? '[]' : ''}${je ? '제' : ''}${word ? word.toLowerCase() : ''}${suffix ?? ''}`,
        strong: Boolean(open || je || word || suffix),
        score: 0,
      });
      continue;
    }
    if (text.length <= 50 && NAMED.test(text)) {
      named.push({ line: i, text, num: null, accepted: true });
    }
  }

  const styleCounts = new Map<string, number>();
  for (const c of numbered) styleCounts.set(c.style, (styleCounts.get(c.style) ?? 0) + 1);
  let dominant = '';
  let dominantCount = 0;
  for (const [style, count] of styleCounts) {
    if (count > dominantCount) [dominant, dominantCount] = [style, count];
  }

  for (const c of numbered) {
    const blankBefore = c.line > 0 && !lines[c.line - 1].trim();
    const blankAfter = c.line + 1 < lines.length && !lines[c.line + 1].trim();
    c.score = (c.style === dominant ? 1 : 0.5) + (blankBefore ? 0.2 : 0) + (blankAfter ? 0.1 : 0);
  }

  // 번호가 이어지는 사슬 중 점수 합이 가장 큰 것을 찾는다 (O(n))
  const total = new Array<number>(numbered.length);
  const prev = new Array<number>(numbered.length);
  const bestByNum = new Map<number, number>();
  let bestIdx = -1;

  for (let i = 0; i < numbered.length; i++) {
    const c = numbered[i];
    let best = 0;
    let from = -1;
    for (let d = 1; d <= MAX_GAP; d++) {
      const j = bestByNum.get(c.num - d);
      if (j !== undefined && total[j] > best) [best, from] = [total[j], j];
    }
    // "1권 1화"처럼 번호가 다시 1부터 시작하는 경우. 오인식을 줄이려고 제N화/N화 같은 형식에만 허용
    if (c.strong && c.num <= 1 && bestIdx >= 0 && total[bestIdx] > best) {
      [best, from] = [total[bestIdx], bestIdx];
    }
    total[i] = best + c.score;
    prev[i] = from;

    const existing = bestByNum.get(c.num);
    if (existing === undefined || total[i] > total[existing]) bestByNum.set(c.num, i);
    if (bestIdx < 0 || total[i] > total[bestIdx]) bestIdx = i;
  }

  const chain = new Set<number>();
  for (let i = bestIdx; i >= 0; i = prev[i]) chain.add(i);
  // 후보가 하나뿐이면 "제1화"처럼 확실한 형식일 때만 채택
  if (chain.size === 1 && !numbered[bestIdx].strong) chain.clear();

  const candidates: Candidate[] = numbered.map((c, i) => ({
    line: c.line,
    text: c.text,
    num: c.num,
    accepted: chain.has(i),
  }));
  return [...candidates, ...named].sort((a, b) => a.line - b.line);
}

/** 사용자가 직접 입력한 정규식에 맞는 줄을 모두 챕터로 본다. */
export function detectWithPattern(lines: string[], bodyStart: number, pattern: RegExp): Candidate[] {
  const candidates: Candidate[] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text || text.length > MAX_HEADING_LENGTH) continue;
    if (pattern.test(text)) candidates.push({ line: i, text, num: null, accepted: true });
  }
  return candidates;
}

/** 챕터 제목 줄 번호를 기준으로 본문을 나눈다. 첫 챕터 앞에 내용이 있으면 "머리말"로 둔다. */
export function buildSections(
  lines: string[],
  bodyStart: number,
  headingLines: number[],
  bookTitle: string,
): Section[] {
  const headings = [...headingLines].sort((a, b) => a - b);
  const sections: Section[] = [];

  const firstHeading = headings[0] ?? lines.length;
  const preface = lines.slice(bodyStart, firstHeading);
  if (preface.some((l) => l.trim())) {
    sections.push({ title: headings.length ? '머리말' : bookTitle || '본문', lines: preface });
  }

  headings.forEach((h, i) => {
    const end = headings[i + 1] ?? lines.length;
    sections.push({
      title: lines[h].trim().replace(/\s+/g, ' '),
      lines: lines.slice(h + 1, end),
    });
  });
  return sections;
}
