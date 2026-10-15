import { EXTRA_FLAGS, type RuleSpec } from './substitute';

export interface Rule extends RuleSpec {
  id: string;
  enabled: boolean;
}

export interface RuleList {
  id: string;
  name: string;
  rules: Rule[];
}

export interface Store {
  lists: RuleList[];
  activeId: string;
}

export const STORAGE_KEY = 'txt2epub.replace.v1';
const EXPORT_FORMAT = 'txt2epub-replace-rules';

let counter = 0;
export function newId(): string {
  return `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newRule(): Rule {
  return { id: newId(), find: '', replace: '', flags: '', enabled: true };
}

export function newList(name: string): RuleList {
  return { id: newId(), name, rules: [newRule()] };
}

function defaultStore(): Store {
  const list = newList('기본 목록');
  return { lists: [list], activeId: list.id };
}

function cleanFlags(flags: unknown): string {
  return typeof flags === 'string' ? [...new Set(flags)].filter((f) => EXTRA_FLAGS.includes(f)).join('') : '';
}

function parseRule(value: unknown): Rule | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.find !== 'string') return null;
  return {
    id: typeof r.id === 'string' ? r.id : newId(),
    find: r.find,
    replace: typeof r.replace === 'string' ? r.replace : '',
    flags: cleanFlags(r.flags),
    enabled: r.enabled !== false,
  };
}

function parseList(value: unknown): RuleList | null {
  if (!value || typeof value !== 'object') return null;
  const l = value as Record<string, unknown>;
  if (!Array.isArray(l.rules)) return null;
  return {
    id: typeof l.id === 'string' ? l.id : newId(),
    name: typeof l.name === 'string' && l.name.trim() ? l.name : '이름 없는 목록',
    rules: l.rules.map(parseRule).filter((r): r is Rule => r !== null),
  };
}

export function loadStore(storage: Pick<Storage, 'getItem'> = localStorage): Store {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const data = JSON.parse(raw) as { lists?: unknown; activeId?: unknown };
    const lists = Array.isArray(data.lists) ? data.lists.map(parseList).filter((l): l is RuleList => l !== null) : [];
    if (!lists.length) return defaultStore();
    const activeId = lists.some((l) => l.id === data.activeId) ? (data.activeId as string) : lists[0].id;
    return { lists, activeId };
  } catch {
    return defaultStore();
  }
}

/** 저장에 실패하면(용량 초과, 저장소 차단 등) false */
export function saveStore(store: Store, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/** 파일로 내보낼 JSON. id는 빼서 사람이 읽고 고치기 쉽게 한다. */
export function exportLists(lists: RuleList[]): string {
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: 1,
      lists: lists.map((l) => ({
        name: l.name,
        rules: l.rules.map(({ find, replace, flags, enabled }) => ({ find, replace, flags, enabled })),
      })),
    },
    null,
    2,
  );
}

/** 내보낸 파일을 읽는다. 새 id를 붙이고, 이미 있는 이름과 겹치면 뒤에 번호를 붙인다. */
export function importLists(json: string, existingNames: string[]): RuleList[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('JSON 형식이 아닙니다.');
  }
  // 목록 하나만 담은 파일이나 목록 배열도 받아 준다
  const raw =
    data && typeof data === 'object' && Array.isArray((data as { lists?: unknown }).lists)
      ? (data as { lists: unknown[] }).lists
      : Array.isArray(data)
        ? data
        : [data];
  const lists = raw.map(parseList).filter((l): l is RuleList => l !== null);
  if (!lists.length) throw new Error('대치 목록을 찾을 수 없습니다.');

  const names = new Set(existingNames);
  return lists.map((l) => {
    let name = l.name;
    for (let n = 2; names.has(name); n++) name = `${l.name} (${n})`;
    names.add(name);
    return { id: newId(), name, rules: l.rules.map((r) => ({ ...r, id: newId() })) };
  });
}
