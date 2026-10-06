import { prepareCover } from './cover';
import type { Encoding } from './decode';
import type { Cover } from './epub';
import type { Candidate } from './parse';
import type { WorkerRequest, WorkerResponse } from './worker';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const drop = $<HTMLLabelElement>('drop');
const txtInput = $<HTMLInputElement>('txt-input');
const dropInfo = $('drop-info');
const editor = $('editor');
const titleInput = $<HTMLInputElement>('title');
const authorInput = $<HTMLInputElement>('author');
const encodingField = $('encoding-field');
const encodingSelect = $<HTMLSelectElement>('encoding');
const fileStats = $('file-stats');
const coverInput = $<HTMLInputElement>('cover-input');
const coverImg = $<HTMLImageElement>('cover-img');
const coverPlaceholder = $('cover-placeholder');
const coverRemove = $<HTMLButtonElement>('cover-remove');
const chapterCount = $('chapter-count');
const chapterList = $<HTMLOListElement>('chapter-list');
const patternForm = $<HTMLFormElement>('pattern-form');
const patternInput = $<HTMLInputElement>('pattern');
const epubNote = $('epub-note');
const selectAuto = $<HTMLButtonElement>('select-auto');
const buildButton = $<HTMLButtonElement>('build');
const status = $('status');

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

let file: File | null = null;
let cover: (Cover & { blob: Blob }) | null = null;
// EPUB 입력에서 사용자가 표지를 바꾸거나 지웠는지
let coverChanged = false;
let candidates: Candidate[] = [];
const selected = new Set<number>();

function send(msg: WorkerRequest, transfer: Transferable[] = []) {
  worker.postMessage(msg, transfer);
}

function setBusy(message: string) {
  status.textContent = message;
  buildButton.disabled = Boolean(message);
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderChapters() {
  chapterCount.textContent = `챕터 ${selected.size}개`;
  if (!candidates.length) {
    chapterList.innerHTML = '<li class="muted">인식된 챕터가 없습니다. 본문 전체가 하나의 챕터로 들어갑니다.</li>';
    return;
  }
  chapterList.innerHTML = candidates
    .map(
      (c) =>
        `<li class="${c.accepted ? '' : 'rejected'}"><label>` +
        `<input type="checkbox" data-line="${c.line}"${selected.has(c.line) ? ' checked' : ''} />` +
        `<span class="text">${escapeHtml(c.text)}</span>` +
        `<span class="line">${c.line + 1}행</span></label></li>`,
    )
    .join('');
}

function setCandidates(list: Candidate[]) {
  candidates = list;
  selected.clear();
  for (const c of list) if (c.accepted) selected.add(c.line);
  renderChapters();
}

async function loadFile(f: File, encoding: Encoding = 'auto') {
  if (f !== file) clearCover();
  file = f;
  dropInfo.textContent = `${f.name} (${formatSize(f.size)})`;
  setBusy('파일 읽는 중...');
  const bytes = await f.arrayBuffer();
  send({ type: 'load', bytes, encoding }, [bytes]);
}

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'loaded': {
      const isEpub = msg.kind === 'epub';
      editor.hidden = false;
      titleInput.value = msg.title;
      authorInput.value = msg.author;
      encodingField.hidden = isEpub;
      epubNote.hidden = !isEpub;
      selectAuto.hidden = !isEpub;
      if (msg.encoding && encodingSelect.value === 'auto') {
        encodingSelect.options[0].textContent = `자동 감지 (${msg.encoding.toUpperCase()})`;
      }
      fileStats.textContent = `${isEpub ? 'EPUB · ' : ''}${msg.lineCount.toLocaleString()}줄 · ${msg.charCount.toLocaleString()}자`;
      patternInput.value = '';
      patternInput.placeholder = `직접 패턴 입력 (정규식, 비우면 ${isEpub ? '원래 목차' : '자동 인식'}) 예: ^제\\d+화`;
      setCandidates(msg.candidates);
      if (msg.cover) setCover(new Blob([msg.cover.data], { type: msg.cover.mediaType }), false);
      setBusy('');
      break;
    }
    case 'detected':
      setCandidates(msg.candidates);
      setBusy('');
      break;
    case 'built': {
      const blob = new Blob([msg.epub], { type: 'application/epub+zip' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(titleInput.value.trim() || 'book').replace(/[\\/:*?"<>|]/g, '_')}.epub`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setBusy('');
      status.textContent =
        msg.mode === 'patched'
          ? `완료 (${formatSize(blob.size)}) · 원본 본문 유지, 정보와 표지만 수정`
          : `완료 (${formatSize(blob.size)})`;
      break;
    }
    case 'error':
      setBusy('');
      status.textContent = `오류: ${msg.message}`;
      break;
  }
};

txtInput.addEventListener('change', () => {
  const f = txtInput.files?.[0];
  if (f) {
    encodingSelect.value = 'auto';
    loadFile(f);
  }
  txtInput.value = '';
});

// 페이지 어디에 놓아도 받는다
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) drop.classList.remove('over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  if (f.type.startsWith('image/')) {
    if (!editor.hidden) setCover(f);
  } else {
    encodingSelect.value = 'auto';
    loadFile(f);
  }
});

encodingSelect.addEventListener('change', () => {
  if (file) loadFile(file, encodingSelect.value as Encoding);
});

async function setCover(image: Blob, changed = true) {
  try {
    cover = await prepareCover(image);
  } catch {
    if (changed) status.textContent = '이미지를 읽을 수 없습니다.';
    return;
  }
  coverChanged ||= changed;
  if (coverImg.src) URL.revokeObjectURL(coverImg.src);
  coverImg.src = URL.createObjectURL(cover.blob);
  coverImg.hidden = false;
  coverPlaceholder.hidden = true;
  coverRemove.hidden = false;
}

coverInput.addEventListener('change', () => {
  const f = coverInput.files?.[0];
  if (f) setCover(f);
  coverInput.value = '';
});

function clearCover() {
  cover = null;
  coverChanged = false;
  if (coverImg.src) URL.revokeObjectURL(coverImg.src);
  coverImg.removeAttribute('src');
  coverImg.hidden = true;
  coverPlaceholder.hidden = false;
  coverRemove.hidden = true;
}

coverRemove.addEventListener('click', () => {
  clearCover();
  coverChanged = true;
});

chapterList.addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement;
  const line = Number(box.dataset.line);
  if (box.checked) selected.add(line);
  else selected.delete(line);
  chapterCount.textContent = `챕터 ${selected.size}개`;
});

selectAuto.addEventListener('click', () => {
  selected.clear();
  for (const c of candidates) if (c.auto) selected.add(c.line);
  renderChapters();
});
$('select-all').addEventListener('click', () => {
  for (const c of candidates) selected.add(c.line);
  renderChapters();
});
$('select-none').addEventListener('click', () => {
  selected.clear();
  renderChapters();
});

patternForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const pattern = patternInput.value;
  try {
    new RegExp(pattern);
  } catch {
    status.textContent = '정규식 형식이 올바르지 않습니다.';
    return;
  }
  setBusy('챕터 찾는 중...');
  send({ type: 'detect', pattern });
});

buildButton.addEventListener('click', () => {
  setBusy('EPUB 만드는 중...');
  // 표지 데이터는 다시 쓸 수 있도록 복사본을 보낸다
  const coverCopy = cover ? { data: cover.data.slice(), width: cover.width, height: cover.height } : undefined;
  send(
    {
      type: 'build',
      title: titleInput.value,
      author: authorInput.value,
      headingLines: [...selected],
      cover: coverCopy ?? null,
      coverChanged,
    },
    coverCopy ? [coverCopy.data.buffer] : [],
  );
});
