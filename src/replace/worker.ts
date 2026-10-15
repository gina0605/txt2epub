/// <reference lib="webworker" />
import { unzipSync } from 'fflate';
import { decode, type Encoding } from '../decode';
import { isZip } from '../epubRead';
import {
  applyToEpubFiles,
  applyToText,
  compileRule,
  emptyResults,
  markupKind,
  normalizeNewlines,
  zipEpub,
  type CompiledRule,
  type RuleResult,
  type RuleSpec,
} from './substitute';

export type WorkerRequest =
  | { type: 'load'; bytes: ArrayBuffer; encoding: Encoding }
  | { type: 'run'; rules: RuleSpec[] };

export type WorkerResponse =
  | { type: 'loaded'; kind: 'txt'; encoding: string; charCount: number; lineCount: number }
  | { type: 'loaded'; kind: 'epub'; documentCount: number }
  | { type: 'progress'; message: string }
  | { type: 'done'; data: Uint8Array<ArrayBuffer>; results: RuleResult[]; elapsed: number }
  | { type: 'error'; message: string; ruleIndex?: number };

declare const self: DedicatedWorkerGlobalScope;

// 큰 파일을 매번 주고받지 않도록 읽은 결과는 워커에 보관한다
let text: { text: string; crlf: boolean } | null = null;
let epub: Record<string, Uint8Array> | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function load(bytes: Uint8Array, encoding: Encoding) {
  text = null;
  epub = null;
  if (isZip(bytes)) {
    const files = unzipSync(bytes);
    if (!files['META-INF/container.xml']) throw new Error('EPUB 파일이 아니거나 손상되었습니다. (container.xml 없음)');
    epub = files;
    post({ type: 'loaded', kind: 'epub', documentCount: Object.keys(files).filter((p) => markupKind(p) === 'html').length });
    return;
  }
  const decoded = decode(bytes, encoding);
  text = normalizeNewlines(decoded.text);
  let lineCount = 1;
  for (let i = text.text.indexOf('\n'); i >= 0; i = text.text.indexOf('\n', i + 1)) lineCount++;
  post({ type: 'loaded', kind: 'txt', encoding: decoded.encoding, charCount: text.text.length, lineCount });
}

function compile(specs: RuleSpec[]): CompiledRule[] {
  return specs.map((spec, i) => {
    try {
      return compileRule(spec);
    } catch (err) {
      throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { ruleIndex: i });
    }
  });
}

function run(specs: RuleSpec[]) {
  const start = performance.now();
  const rules = compile(specs);
  const results = emptyResults(rules.length);
  let data: Uint8Array<ArrayBuffer>;

  if (text) {
    let current = 0;
    let out: string;
    try {
      out = applyToText(text.text, rules, results, (i) => {
        current = i;
        post({ type: 'progress', message: `규칙 적용 중 (${i + 1}/${rules.length})` });
      });
    } catch (err) {
      // 되돌아가며 찾는 단계가 너무 깊어지면 정규식 엔진이 스택 초과로 멈춘다
      if (err instanceof RangeError) {
        throw Object.assign(
          new Error(`정규식이 너무 복잡하거나 한 번에 매치하는 범위가 너무 깁니다. (${err.message})`),
          { ruleIndex: current },
        );
      }
      throw err;
    }
    if (text.crlf) out = out.replace(/\n/g, '\r\n');
    post({ type: 'progress', message: '파일 만드는 중...' });
    data = new TextEncoder().encode(out);
  } else if (epub) {
    let lastReport = 0;
    const files = applyToEpubFiles(epub, rules, results, (done, total) => {
      // 메시지가 너무 많아지지 않게 0.1초에 한 번만 알린다
      const now = performance.now();
      if (now - lastReport < 100) return;
      lastReport = now;
      post({ type: 'progress', message: `규칙 적용 중 (${done}/${total} 문서)` });
    });
    post({ type: 'progress', message: 'EPUB 압축하는 중...' });
    data = zipEpub(files) as Uint8Array<ArrayBuffer>;
  } else {
    throw new Error('파일을 먼저 선택하세요.');
  }

  post({ type: 'done', data, results, elapsed: performance.now() - start }, [data.buffer]);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') load(new Uint8Array(msg.bytes), msg.encoding);
    else run(msg.rules);
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      ruleIndex: (err as { ruleIndex?: number }).ruleIndex,
    });
  }
};
