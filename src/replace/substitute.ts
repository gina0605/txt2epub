import { strFromU8, strToU8, zipSync, type Zippable } from 'fflate';
import { decodeEntities } from '../epubRead';

/** 대치 규칙 하나. flags에는 g, m을 제외한 추가 플래그(i, s, u)만 담는다. */
export interface RuleSpec {
  find: string;
  replace: string;
  flags: string;
}

export interface Sample {
  before: string;
  match: string;
  replacement: string;
  after: string;
}

export interface RuleResult {
  count: number;
  samples: Sample[];
}

const SAMPLE_LIMIT = 30;
const SAMPLE_CONTEXT = 24;
export const EXTRA_FLAGS = 'isu';

type Part =
  | { t: 'lit'; s: string }
  | { t: 'cap'; n: number }
  | { t: 'name'; s: string }
  | { t: 'pre' }
  | { t: 'post' };

export interface CompiledRule {
  re: RegExp;
  parts: Part[];
  hasNamed: boolean;
}

/** 줄 단위로 다루기 쉽도록 g, m 플래그는 항상 켠다 */
export function buildRegExp(find: string, flags: string): RegExp {
  const extra = [...new Set(flags)].filter((f) => EXTRA_FLAGS.includes(f)).join('');
  return new RegExp(find, `gm${extra}`);
}

/** 정규식이 올바르지 않으면 오류 메시지를, 올바르면 null을 돌려준다 */
export function regexError(find: string, flags: string): string | null {
  if (!find) return '찾을 내용이 비어 있습니다.';
  try {
    buildRegExp(find, flags);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 바꿀 내용의 \n, \t, \\를 실제 줄바꿈, 탭, 역슬래시로 바꾼다 */
export function unescapeReplacement(s: string): string {
  return s.replace(/\\([nt\\])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
}

/**
 * String.prototype.replace의 $1, $<name>, $&, $`, $', $$ 규칙을 미리 해석해 둔다.
 * 직접 치환해야 매치마다 개수와 예시를 모으면서도 한 번만 훑을 수 있다.
 */
function compileTemplate(template: string, captureCount: number, hasNamed: boolean): Part[] {
  const parts: Part[] = [];
  let lit = '';
  const flush = () => {
    if (lit) parts.push({ t: 'lit', s: lit });
    lit = '';
  };
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    const n = template[i + 1];
    if (c !== '$' || n === undefined) {
      lit += c;
    } else if (n === '$') {
      lit += '$';
      i++;
    } else if (n === '&' || n === '`' || n === "'") {
      flush();
      parts.push(n === '&' ? { t: 'cap', n: 0 } : { t: n === '`' ? 'pre' : 'post' });
      i++;
    } else if (n >= '0' && n <= '9') {
      const two = template.slice(i + 1, i + 3);
      if (/^\d\d$/.test(two) && Number(two) >= 1 && Number(two) <= captureCount) {
        flush();
        parts.push({ t: 'cap', n: Number(two) });
        i += 2;
      } else if (n !== '0' && Number(n) <= captureCount) {
        flush();
        parts.push({ t: 'cap', n: Number(n) });
        i++;
      } else {
        lit += '$';
      }
    } else if (n === '<' && hasNamed && template.indexOf('>', i + 2) >= 0) {
      const end = template.indexOf('>', i + 2);
      flush();
      parts.push({ t: 'name', s: template.slice(i + 2, end) });
      i = end;
    } else {
      lit += '$';
    }
  }
  flush();
  return parts;
}

export function compileRule(rule: RuleSpec): CompiledRule {
  const re = buildRegExp(rule.find, rule.flags);
  // 빈 문자열에 반드시 매치되는 정규식으로 캡처 그룹 수와 이름 있는 그룹 여부를 알아낸다
  const probe = new RegExp(`${re.source}|`, re.flags).exec('')!;
  const hasNamed = probe.groups !== undefined;
  return { re, hasNamed, parts: compileTemplate(unescapeReplacement(rule.replace), probe.length - 1, hasNamed) };
}

/** 규칙 하나를 적용한다. result에 매치 수와 앞부분 예시를 쌓는다. */
export function applyRule(text: string, rule: CompiledRule, result: RuleResult): string {
  const { parts, hasNamed } = rule;
  return text.replace(rule.re, (...args: unknown[]) => {
    const groups = hasNamed ? (args.pop() as Record<string, string | undefined>) : undefined;
    const str = args.pop() as string;
    const offset = args.pop() as number;
    const match = args[0] as string;
    let out = '';
    for (const p of parts) {
      switch (p.t) {
        case 'lit':
          out += p.s;
          break;
        case 'cap':
          out += (args[p.n] as string | undefined) ?? '';
          break;
        case 'name':
          out += groups?.[p.s] ?? '';
          break;
        case 'pre':
          out += str.slice(0, offset);
          break;
        case 'post':
          out += str.slice(offset + match.length);
          break;
      }
    }
    result.count++;
    if (result.samples.length < SAMPLE_LIMIT) {
      result.samples.push({
        before: str.slice(Math.max(0, offset - SAMPLE_CONTEXT), offset),
        match,
        replacement: out,
        after: str.slice(offset + match.length, offset + match.length + SAMPLE_CONTEXT),
      });
    }
    return out;
  });
}

export function emptyResults(count: number): RuleResult[] {
  return Array.from({ length: count }, () => ({ count: 0, samples: [] }));
}

/** CRLF를 LF로 바꿔 ^, $가 \r과 \n 사이에서 빈 줄로 매치되지 않게 한다 */
export function normalizeNewlines(text: string): { text: string; crlf: boolean } {
  const crlf = text.includes('\r\n');
  return { text: text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text, crlf };
}

export function applyToText(
  text: string,
  rules: CompiledRule[],
  results: RuleResult[],
  onRule?: (index: number) => void,
): string {
  rules.forEach((rule, i) => {
    onRule?.(i);
    text = applyRule(text, rule, results[i]);
  });
  return text;
}

const MARKUP_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g;
const TAG_NAME = /^<(\/?)(?:[\w-]+:)?([\w-]+)/;

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * XHTML은 body 안(script, style 제외), NCX는 <text> 안의 글자에만 규칙을 적용한다.
 * 태그와 속성은 건드리지 않으며, 태그로 나뉜 글자에 걸친 매치는 찾지 못한다.
 */
export function applyToMarkup(src: string, kind: 'html' | 'ncx', rules: CompiledRule[], results: RuleResult[]): string {
  const out: string[] = [];
  let last = 0;
  let inBody = false;
  let skipDepth = 0;
  let active = false;

  const processText = (text: string) => {
    if (!active || !/\S/.test(text)) return text;
    const decoded = text.includes('&') ? decodeEntities(text) : text;
    let s = decoded;
    rules.forEach((rule, i) => {
      s = applyRule(s, rule, results[i]);
    });
    return s === decoded ? text : escapeText(s);
  };

  for (const m of src.matchAll(MARKUP_TOKEN)) {
    out.push(processText(src.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;

    const tag = TAG_NAME.exec(m[0]);
    if (!tag) continue;
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    if (kind === 'ncx') {
      if (name === 'text') active = !closing && !m[0].endsWith('/>');
      continue;
    }
    if (name === 'body') inBody = !closing && !m[0].endsWith('/>');
    else if ((name === 'script' || name === 'style') && !m[0].endsWith('/>')) skipDepth = Math.max(0, skipDepth + (closing ? -1 : 1));
    active = inBody && skipDepth === 0;
  }
  out.push(processText(src.slice(last)));
  return out.join('');
}

export function markupKind(path: string): 'html' | 'ncx' | null {
  if (/\.(xhtml|html?|xht)$/i.test(path)) return 'html';
  if (/\.ncx$/i.test(path)) return 'ncx';
  return null;
}

/** 본문 파일에 규칙을 적용한 새 파일 목록을 돌려준다. 바뀌지 않은 파일은 원본 데이터를 그대로 쓴다. */
export function applyToEpubFiles(
  files: Record<string, Uint8Array>,
  rules: CompiledRule[],
  results: RuleResult[],
  onFile?: (done: number, total: number) => void,
): Record<string, Uint8Array> {
  const out = { ...files };
  const targets = Object.keys(files).filter((p) => markupKind(p));
  targets.forEach((path, i) => {
    onFile?.(i, targets.length);
    const src = strFromU8(files[path]);
    const changed = applyToMarkup(src, markupKind(path)!, rules, results);
    if (changed !== src) out[path] = strToU8(changed);
  });
  return out;
}

// 이미 압축된 형식은 다시 압축해도 줄지 않으므로 시간만 아끼도록 저장만 한다
const STORED = /\.(jpe?g|png|gif|webp|avif|mp3|m4a|mp4|ogg|woff2?)$/i;

export function zipEpub(files: Record<string, Uint8Array>): Uint8Array {
  // mimetype은 반드시 ZIP의 첫 번째 파일이어야 하고 압축하지 않아야 한다
  const out: Zippable = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  for (const [path, data] of Object.entries(files)) {
    if (path !== 'mimetype') out[path] = [data, { level: STORED.test(path) ? 0 : 6 }];
  }
  return zipSync(out);
}
