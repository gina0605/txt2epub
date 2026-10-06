/// <reference lib="webworker" />
import { decode, type Encoding } from './decode';
import { buildEpub, type Cover } from './epub';
import { buildSections, detectChapters, detectWithPattern, findTitle, splitLines, type Candidate } from './parse';

export type WorkerRequest =
  | { type: 'load'; bytes: ArrayBuffer; encoding: Encoding }
  | { type: 'detect'; pattern: string }
  | { type: 'build'; title: string; author: string; headingLines: number[]; cover?: Cover };

export type WorkerResponse =
  | { type: 'loaded'; encoding: string; title: string; lineCount: number; charCount: number; candidates: Candidate[] }
  | { type: 'detected'; candidates: Candidate[] }
  | { type: 'built'; epub: ArrayBuffer }
  | { type: 'error'; message: string };

declare const self: DedicatedWorkerGlobalScope;

// 큰 텍스트를 매번 주고받지 않도록 읽은 결과는 워커에 보관한다
let lines: string[] = [];
let bodyStart = 0;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'load': {
        const decoded = decode(new Uint8Array(msg.bytes), msg.encoding);
        lines = splitLines(decoded.text);
        const found = findTitle(lines);
        bodyStart = found.bodyStart;
        post({
          type: 'loaded',
          encoding: decoded.encoding,
          title: found.title,
          lineCount: lines.length,
          charCount: decoded.text.length,
          candidates: detectChapters(lines, bodyStart),
        });
        break;
      }
      case 'detect': {
        const candidates = msg.pattern.trim()
          ? detectWithPattern(lines, bodyStart, new RegExp(msg.pattern.trim(), 'i'))
          : detectChapters(lines, bodyStart);
        post({ type: 'detected', candidates });
        break;
      }
      case 'build': {
        const sections = buildSections(lines, bodyStart, msg.headingLines, msg.title);
        const epub = buildEpub({ title: msg.title, author: msg.author, sections, cover: msg.cover });
        post({ type: 'built', epub: epub.buffer as ArrayBuffer }, [epub.buffer]);
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
