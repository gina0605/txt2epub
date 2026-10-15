import type { Encoding } from '../decode';
import {
  exportLists,
  importLists,
  loadStore,
  newId,
  newList,
  newRule,
  saveStore,
  STORAGE_KEY,
  type Rule,
  type RuleList,
  type Store,
} from './rules';
import { regexError, type RuleResult, type Sample } from './substitute';
import type { WorkerRequest, WorkerResponse } from './worker';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const listSelect = $<HTMLSelectElement>('list-select');
const listName = $<HTMLInputElement>('list-name');
const ruleList = $<HTMLOListElement>('rule-list');
const saveStatus = $('save-status');
const importInput = $<HTMLInputElement>('import-input');
const drop = $<HTMLLabelElement>('drop');
const fileInput = $<HTMLInputElement>('file-input');
const dropInfo = $('drop-info');
const fileBar = $('file-bar');
const fileStats = $('file-stats');
const encodingField = $('encoding-field');
const chapterField = $('chapter-field');
const chapterSelect = $<HTMLSelectElement>('chapter');
const encodingSelect = $<HTMLSelectElement>('encoding');
const runButton = $<HTMLButtonElement>('run');
const cancelButton = $<HTMLButtonElement>('cancel');
const status = $('status');
const resultSection = $('result');
const resultTitle = $('result-title');
const resultNote = $('result-note');
const resultList = $<HTMLOListElement>('result-list');
const downloadButton = $<HTMLButtonElement>('download');

let store: Store = loadStore();
let file: File | null = null;
let fileReady = false;
let running = false;
let result: { url: string; name: string } | null = null;

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const safeFileName = (s: string) => s.trim().replace(/[\\/:*?"<>|]/g, '_') || '대치 목록';

/* ---------- 목록 저장 ---------- */

function activeList(): RuleList {
  return store.lists.find((l) => l.id === store.activeId) ?? store.lists[0];
}

function save() {
  const ok = saveStore(store);
  saveStatus.hidden = ok;
  saveStatus.textContent = ok ? '' : '브라우저에 저장하지 못했습니다. 목록을 파일로 내보내 두세요.';
  markStale();
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 300);
}
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  saveStore(store);
});

// 다른 탭에서 목록을 고치면 이 탭에도 반영한다
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY) return;
  store = loadStore();
  renderLists();
  renderRules();
});

/* ---------- 목록 화면 ---------- */

function renderLists() {
  const list = activeList();
  listSelect.innerHTML = store.lists
    .map((l) => `<option value="${escapeHtml(l.id)}"${l.id === list.id ? ' selected' : ''}>${escapeHtml(l.name)} · ${l.rules.length}개</option>`)
    .join('');
  listName.value = list.name;
}

function ruleRow(rule: Rule, i: number) {
  const flag = (f: string, title: string) =>
    `<label class="flag" title="${title}"><input type="checkbox" data-flag="${f}"${rule.flags.includes(f) ? ' checked' : ''} />${f}</label>`;
  return (
    `<li class="rule${rule.enabled ? '' : ' off'}" data-index="${i}">` +
    `<label class="toggle" title="사용"><input type="checkbox" class="enabled"${rule.enabled ? ' checked' : ''} /><span class="num">${i + 1}</span></label>` +
    `<input type="text" class="find" placeholder="찾을 정규식" spellcheck="false" value="${escapeHtml(rule.find)}" />` +
    `<span class="arrow">→</span>` +
    `<input type="text" class="replace" placeholder="바꿀 내용" spellcheck="false" value="${escapeHtml(rule.replace)}" />` +
    `<span class="flags">${flag('i', '대소문자 무시')}${flag('s', '.이 줄바꿈도 포함')}</span>` +
    `<span class="ops">` +
    `<button type="button" data-op="up" title="위로">↑</button>` +
    `<button type="button" data-op="down" title="아래로">↓</button>` +
    `<button type="button" data-op="del" title="삭제">✕</button>` +
    `</span>` +
    `<p class="error"></p>` +
    `</li>`
  );
}

function validateRow(li: HTMLElement, rule: Rule) {
  const error = rule.find ? regexError(rule.find, rule.flags) : null;
  li.classList.toggle('invalid', Boolean(error));
  li.querySelector('.error')!.textContent = error ?? '';
}

function renderRules() {
  const list = activeList();
  if (!list.rules.length) {
    ruleList.innerHTML = '<li class="empty muted">규칙이 없습니다. 아래에서 추가하세요.</li>';
    return;
  }
  ruleList.innerHTML = list.rules.map(ruleRow).join('');
  ruleList.querySelectorAll<HTMLElement>('li.rule').forEach((li, i) => validateRow(li, list.rules[i]));
}

function rowOf(target: EventTarget | null) {
  const li = (target as HTMLElement).closest<HTMLElement>('li.rule');
  if (!li) return null;
  const index = Number(li.dataset.index);
  return { li, index, rule: activeList().rules[index] };
}

// 글자 입력 중에는 다시 그리지 않아야 커서가 유지된다
ruleList.addEventListener('input', (e) => {
  const row = rowOf(e.target);
  if (!row) return;
  const input = e.target as HTMLInputElement;
  if (input.classList.contains('find')) row.rule.find = input.value;
  else if (input.classList.contains('replace')) row.rule.replace = input.value;
  else return;
  validateRow(row.li, row.rule);
  saveSoon();
});

ruleList.addEventListener('change', (e) => {
  const row = rowOf(e.target);
  if (!row) return;
  const input = e.target as HTMLInputElement;
  if (input.classList.contains('enabled')) {
    row.rule.enabled = input.checked;
    row.li.classList.toggle('off', !input.checked);
  } else if (input.dataset.flag) {
    const f = input.dataset.flag;
    row.rule.flags = input.checked ? row.rule.flags + f : row.rule.flags.replace(f, '');
    validateRow(row.li, row.rule);
  } else {
    return;
  }
  save();
});

ruleList.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-op]');
  const row = button && rowOf(button);
  if (!row) return;
  const rules = activeList().rules;
  const { index } = row;
  const op = button.dataset.op;
  if (op === 'del') rules.splice(index, 1);
  else {
    const to = op === 'up' ? index - 1 : index + 1;
    if (to < 0 || to >= rules.length) return;
    [rules[index], rules[to]] = [rules[to], rules[index]];
  }
  save();
  renderLists();
  renderRules();
  if (op !== 'del') ruleList.querySelector<HTMLButtonElement>(`li[data-index="${op === 'up' ? index - 1 : index + 1}"] [data-op="${op}"]`)?.focus();
});

$('rule-add').addEventListener('click', () => {
  activeList().rules.push(newRule());
  save();
  renderLists();
  renderRules();
  ruleList.querySelector<HTMLInputElement>('li.rule:last-child .find')?.focus();
});

listSelect.addEventListener('change', () => {
  store.activeId = listSelect.value;
  save();
  renderLists();
  renderRules();
});

listName.addEventListener('input', () => {
  activeList().name = listName.value;
  const option = listSelect.selectedOptions[0];
  if (option) option.textContent = `${listName.value} · ${activeList().rules.length}개`;
  saveSoon();
});
listName.addEventListener('change', () => {
  if (!listName.value.trim()) {
    activeList().name = '이름 없는 목록';
    renderLists();
    save();
  }
});

function addList(list: RuleList) {
  store.lists.push(list);
  store.activeId = list.id;
  save();
  renderLists();
  renderRules();
}

$('list-new').addEventListener('click', () => {
  const names = new Set(store.lists.map((l) => l.name));
  let name = '새 목록';
  for (let n = 2; names.has(name); n++) name = `새 목록 ${n}`;
  addList(newList(name));
  listName.select();
});

$('list-copy').addEventListener('click', () => {
  const list = activeList();
  addList({ id: newId(), name: `${list.name} 사본`, rules: list.rules.map((r) => ({ ...r, id: newId() })) });
});

$('list-delete').addEventListener('click', () => {
  const list = activeList();
  if (!confirm(`"${list.name}" 목록을 삭제할까요? 규칙 ${list.rules.length}개가 함께 지워집니다.`)) return;
  store.lists = store.lists.filter((l) => l !== list);
  if (!store.lists.length) store.lists.push(newList('기본 목록'));
  store.activeId = store.lists[0].id;
  save();
  renderLists();
  renderRules();
});

$('export-one').addEventListener('click', () => {
  const list = activeList();
  download(new Blob([exportLists([list])], { type: 'application/json' }), `${safeFileName(list.name)}.json`);
});

$('export-all').addEventListener('click', () => {
  download(new Blob([exportLists(store.lists)], { type: 'application/json' }), '대치 목록 전체.json');
});

importInput.addEventListener('change', async () => {
  const f = importInput.files?.[0];
  importInput.value = '';
  if (!f) return;
  try {
    const lists = importLists(await f.text(), store.lists.map((l) => l.name));
    store.lists.push(...lists);
    store.activeId = lists[0].id;
    save();
    renderLists();
    renderRules();
    status.textContent = `목록 ${lists.length}개를 가져왔습니다: ${lists.map((l) => l.name).join(', ')}`;
  } catch (err) {
    status.textContent = `가져오기 실패: ${err instanceof Error ? err.message : err}`;
  }
});

/* ---------- 파일 처리 ---------- */

let worker: Worker;

function createWorker() {
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    finishRun();
    status.textContent = `오류: ${e.message || '처리 중 문제가 생겼습니다. 파일이 너무 크면 메모리가 부족할 수 있습니다.'}`;
  };
}

function send(msg: WorkerRequest, transfer: Transferable[] = []) {
  worker.postMessage(msg, transfer);
}

function updateRunButton() {
  runButton.disabled = running || !fileReady;
}

async function loadFile(f: File, encoding: Encoding = 'auto') {
  if (f !== file) chapterSelect.value = 'all';
  file = f;
  fileReady = false;
  updateRunButton();
  clearResult();
  dropInfo.textContent = `${f.name} (${formatSize(f.size)})`;
  status.textContent = '파일 읽는 중...';
  const bytes = await f.arrayBuffer();
  send({ type: 'load', bytes, encoding }, [bytes]);
}

/** 실행 시점의 규칙. 결과 화면에서 몇 번째 규칙인지 보여주기 위해 원래 번호도 기억한다. */
let ranRules: { number: number; rule: Rule }[] = [];
let runStart = 0;
/** 실행할 때 고른 챕터 (null이면 전체) */
let ranChapter: number | null = null;
let runMessage = '';
let runTimer = 0;
/** 파일을 다 읽은 뒤 보여줄 상태 메시지 */
let afterLoadMessage = '';

function renderChapters(chapters: { title: string; fileCount: number }[]) {
  // 같은 파일을 다시 읽을 때(중지 후 등)는 고른 챕터를 유지한다
  const previous = chapterSelect.value;
  chapterSelect.innerHTML =
    '<option value="all">책 전체</option>' +
    chapters
      .map((c, i) => `<option value="${i}">${i + 1}. ${escapeHtml(c.title)}${c.fileCount > 1 ? ` (파일 ${c.fileCount}개)` : ''}</option>`)
      .join('');
  chapterSelect.value = previous && Number(previous) < chapters.length ? previous : 'all';
}

chapterSelect.addEventListener('change', markStale);

function startRun() {
  const rules = activeList().rules;
  const enabled = rules.map((rule, i) => ({ number: i + 1, rule })).filter((r) => r.rule.enabled && r.rule.find);
  const invalid = enabled.find((r) => regexError(r.rule.find, r.rule.flags));
  if (invalid) {
    status.textContent = `${invalid.number}번 규칙의 정규식이 올바르지 않습니다.`;
    return;
  }
  if (!enabled.length) {
    status.textContent = '적용할 규칙이 없습니다.';
    return;
  }
  ranRules = enabled.map((r) => ({ number: r.number, rule: { ...r.rule } }));
  ranChapter = chapterField.hidden || chapterSelect.value === 'all' ? null : Number(chapterSelect.value);
  running = true;
  runStart = performance.now();
  updateRunButton();
  cancelButton.hidden = false;
  // 정규식 하나가 오래 걸려도 멈춘 게 아님을 알 수 있게 경과 시간을 계속 갱신한다
  runMessage = '규칙 적용 중';
  showRunStatus();
  runTimer = window.setInterval(showRunStatus, 200);
  send({
    type: 'run',
    rules: ranRules.map(({ rule }) => ({ find: rule.find, replace: rule.replace, flags: rule.flags })),
    chapter: ranChapter,
  });
}

function showRunStatus() {
  status.textContent = `${runMessage} · ${((performance.now() - runStart) / 1000).toFixed(1)}초`;
}

function finishRun() {
  clearInterval(runTimer);
  running = false;
  cancelButton.hidden = true;
  updateRunButton();
}

function onWorkerMessage(e: MessageEvent<WorkerResponse>) {
  const msg = e.data;
  switch (msg.type) {
    case 'loaded':
      fileReady = true;
      updateRunButton();
      fileBar.hidden = false;
      encodingField.hidden = msg.kind === 'epub';
      chapterField.hidden = msg.kind !== 'epub' || !msg.chapters.length;
      if (msg.kind === 'epub') renderChapters(msg.chapters);
      if (msg.kind === 'txt') {
        if (encodingSelect.value === 'auto') encodingSelect.options[0].textContent = `자동 감지 (${msg.encoding.toUpperCase()})`;
        fileStats.textContent = `txt · ${msg.lineCount.toLocaleString()}줄 · ${msg.charCount.toLocaleString()}자`;
      } else {
        fileStats.textContent = `EPUB · 본문 문서 ${msg.documentCount.toLocaleString()}개`;
      }
      status.textContent = afterLoadMessage;
      afterLoadMessage = '';
      break;
    case 'progress':
      if (!running) break;
      runMessage = msg.message;
      showRunStatus();
      break;
    case 'done':
      finishRun();
      showResult(msg.data, msg.results, msg.elapsed);
      status.textContent = '';
      break;
    case 'error':
      finishRun();
      // 워커는 실행한 규칙 중 몇 번째인지 알려주므로 목록에서의 번호로 바꾼다
      status.textContent =
        msg.ruleIndex === undefined ? `오류: ${msg.message}` : `오류: ${ranRules[msg.ruleIndex].number}번 규칙: ${msg.message}`;
      break;
  }
}

cancelButton.addEventListener('click', () => {
  // 정규식이 오래 걸리면 워커를 강제로 멈출 수밖에 없다. 새 워커에 파일을 다시 읽힌다.
  worker.terminate();
  createWorker();
  finishRun();
  afterLoadMessage = '중지했습니다.';
  if (file) loadFile(file, encodingSelect.value as Encoding);
});

runButton.addEventListener('click', startRun);

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (f) {
    encodingSelect.value = 'auto';
    encodingSelect.options[0].textContent = '자동 감지';
    loadFile(f);
  }
});

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
  if (!f || running) return;
  if (/\.json$/i.test(f.name)) {
    status.textContent = '목록 파일은 "가져오기"로 불러오세요.';
    return;
  }
  encodingSelect.value = 'auto';
  encodingSelect.options[0].textContent = '자동 감지';
  loadFile(f);
});

encodingSelect.addEventListener('change', () => {
  if (file && !running) loadFile(file, encodingSelect.value as Encoding);
});

/* ---------- 결과 ---------- */

function clearResult() {
  if (result) URL.revokeObjectURL(result.url);
  result = null;
  resultSection.hidden = true;
}

function markStale() {
  if (result) resultNote.textContent = '규칙이나 적용 범위가 바뀌었습니다. 다시 실행해야 반영됩니다. 다운로드는 이전 실행 결과입니다.';
}

// 줄바꿈을 눈에 보이게 표시한다
const visible = (s: string) => escapeHtml(s).replace(/\n/g, '<span class="nl">↵</span>');

function sampleHtml(s: Sample) {
  return `<li>${visible(s.before)}<del>${visible(s.match)}</del><ins>${visible(s.replacement)}</ins>${visible(s.after)}</li>`;
}

function showResult(data: Uint8Array<ArrayBuffer>, results: RuleResult[], elapsed: number) {
  clearResult();
  const name = file!.name;
  const blob = new Blob([data], { type: /\.epub$/i.test(name) ? 'application/epub+zip' : 'text/plain;charset=utf-8' });
  result = { url: URL.createObjectURL(blob), name };

  const total = results.reduce((n, r) => n + r.count, 0);
  resultTitle.textContent = `결과 · ${total.toLocaleString()}곳 바뀜`;
  const scope = ranChapter === null ? '' : ` · ${chapterSelect.options[ranChapter + 1]?.textContent ?? ''}에만 적용`;
  resultNote.textContent = `${(elapsed / 1000).toFixed(1)}초 · ${formatSize(blob.size)}${fileStats.textContent?.startsWith('txt') ? ' · UTF-8로 저장' : ''}${scope}`;
  resultList.innerHTML = results
    .map((r, i) => {
      const { number, rule } = ranRules[i];
      const label =
        `<span class="count">${r.count.toLocaleString()}건</span>` +
        `<span class="num">${number}</span><code>${escapeHtml(rule.find)}</code> → <code>${escapeHtml(rule.replace) || '<span class="muted">(지움)</span>'}</code>`;
      if (!r.count) return `<li class="zero"><div class="summary">${label}</div></li>`;
      const more = r.count > r.samples.length ? `<li class="muted">외 ${(r.count - r.samples.length).toLocaleString()}건</li>` : '';
      return `<li><details><summary>${label}</summary><ol class="samples">${r.samples.map(sampleHtml).join('')}${more}</ol></details></li>`;
    })
    .join('');
  resultSection.hidden = false;
}

downloadButton.addEventListener('click', () => {
  if (!result) return;
  const a = document.createElement('a');
  a.href = result.url;
  a.download = result.name;
  a.click();
});

createWorker();
renderLists();
renderRules();
