/// <reference lib="webworker" />
import { decode, type Encoding } from './decode';
import { buildEpub, type Cover } from './epub';
import { isZip, patchEpub, readEpub, type EpubBook } from './epubRead';
import { buildSections, detectChapters, detectWithPattern, findTitle, splitLines, type Candidate } from './parse';

export type WorkerRequest =
  | { type: 'load'; bytes: ArrayBuffer; encoding: Encoding }
  | { type: 'detect'; pattern: string }
  | {
      type: 'build';
      title: string;
      author: string;
      headingLines: number[];
      cover: Cover | null;
      /** 사용자가 표지를 바꾸거나 지웠는지 */
      coverChanged: boolean;
    };

export type WorkerResponse =
  | {
      type: 'loaded';
      kind: 'txt' | 'epub';
      encoding?: string;
      title: string;
      author: string;
      lineCount: number;
      charCount: number;
      candidates: Candidate[];
      cover?: { data: ArrayBuffer; mediaType: string };
    }
  | { type: 'detected'; candidates: Candidate[] }
  /** patched: 원본 EPUB의 본문을 유지하고 정보만 수정 / built: 본문을 새로 구성 */
  | { type: 'built'; epub: ArrayBuffer; mode: 'patched' | 'built' }
  | { type: 'error'; message: string };

declare const self: DedicatedWorkerGlobalScope;

// 큰 텍스트를 매번 주고받지 않도록 읽은 결과는 워커에 보관한다
let lines: string[] = [];
let bodyStart = 0;
let book: EpubBook | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function sameLines(a: number[], b: number[]) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

/** EPUB은 원본 목차를 선택된 챕터로, 자동 인식한 나머지 후보는 선택 안 된 상태로 보여준다 */
function epubCandidates(b: EpubBook): Candidate[] {
  const detected = detectChapters(lines, 0);
  const auto = new Set(detected.filter((c) => c.accepted).map((c) => c.line));
  const toc = new Set(b.headingLines);
  const original = b.headingLines.map((line) => ({
    line,
    text: lines[line].trim(),
    num: null,
    accepted: true,
    auto: auto.has(line),
  }));
  const extra = detected.filter((c) => !toc.has(c.line)).map((c) => ({ ...c, accepted: false, auto: c.accepted }));
  return [...original, ...extra].sort((x, y) => x.line - y.line);
}

function load(bytes: Uint8Array, encoding: Encoding) {
  if (isZip(bytes)) {
    book = readEpub(bytes);
    lines = book.lines;
    bodyStart = 0;
    const coverBytes = book.coverItem && book.files[book.coverItem.path];
    const cover = coverBytes ? { data: coverBytes.slice().buffer, mediaType: book.coverItem!.mediaType } : undefined;
    post(
      {
        type: 'loaded',
        kind: 'epub',
        title: book.title,
        author: book.author,
        lineCount: lines.length,
        charCount: lines.reduce((n, l) => n + l.length, 0),
        candidates: epubCandidates(book),
        cover,
      },
      cover ? [cover.data] : [],
    );
    return;
  }

  book = null;
  const decoded = decode(bytes, encoding);
  lines = splitLines(decoded.text);
  const found = findTitle(lines);
  bodyStart = found.bodyStart;
  post({
    type: 'loaded',
    kind: 'txt',
    encoding: decoded.encoding,
    title: found.title,
    author: '',
    lineCount: lines.length,
    charCount: decoded.text.length,
    candidates: detectChapters(lines, bodyStart),
  });
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'load':
        load(new Uint8Array(msg.bytes), msg.encoding);
        break;
      case 'detect': {
        // 패턴을 비우면 txt는 자동 인식, EPUB은 원래 목차로 되돌린다
        const candidates = msg.pattern.trim()
          ? detectWithPattern(lines, bodyStart, new RegExp(msg.pattern.trim(), 'i'))
          : book
            ? epubCandidates(book)
            : detectChapters(lines, bodyStart);
        post({ type: 'detected', candidates });
        break;
      }
      case 'build': {
        // EPUB에서 챕터 구성을 바꾸지 않았다면 원본의 서식과 이미지를 살리기 위해 정보만 수정한다
        if (book && sameLines(msg.headingLines, book.headingLines)) {
          const epub = patchEpub(book, {
            title: msg.title,
            author: msg.author,
            cover: msg.coverChanged ? msg.cover : undefined,
          });
          post({ type: 'built', epub: epub.buffer as ArrayBuffer, mode: 'patched' }, [epub.buffer]);
          break;
        }
        const sections = buildSections(lines, bodyStart, msg.headingLines, msg.title);
        const epub = buildEpub({
          title: msg.title,
          author: msg.author,
          language: book?.language,
          sections,
          cover: msg.cover ?? undefined,
        });
        post({ type: 'built', epub: epub.buffer as ArrayBuffer, mode: 'built' }, [epub.buffer]);
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
