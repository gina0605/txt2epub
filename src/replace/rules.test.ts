import { describe, expect, it } from 'vitest';
import { exportLists, importLists, loadStore, saveStore, STORAGE_KEY, type Store } from './rules';

function memory(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const store: Store = {
  activeId: 'b',
  lists: [
    { id: 'a', name: '오타', rules: [{ id: 'r1', find: '됬', replace: '됐', flags: '', enabled: true }] },
    { id: 'b', name: '이름', rules: [{ id: 'r2', find: '철수', replace: '민수', flags: 'i', enabled: false }] },
  ],
};

describe('브라우저 저장', () => {
  it('저장한 목록을 그대로 불러온다', () => {
    const s = memory();
    expect(saveStore(store, s)).toBe(true);
    expect(loadStore(s)).toEqual(store);
  });

  it('비었거나 깨진 데이터면 기본 목록을 만든다', () => {
    for (const raw of [undefined, '{', '{"lists":[]}']) {
      const loaded = loadStore(memory(raw));
      expect(loaded.lists).toHaveLength(1);
      expect(loaded.activeId).toBe(loaded.lists[0].id);
    }
  });

  it('저장에 실패하면 false', () => {
    const full = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(saveStore(store, full)).toBe(false);
  });
});

describe('파일 내보내기/가져오기', () => {
  it('내보낸 파일을 다시 가져올 수 있다', () => {
    const imported = importLists(exportLists(store.lists), []);
    expect(imported.map((l) => l.name)).toEqual(['오타', '이름']);
    expect(imported[1].rules[0]).toMatchObject({ find: '철수', replace: '민수', flags: 'i', enabled: false });
    // 새 id를 받는다
    expect(imported[0].id).not.toBe('a');
  });

  it('이름이 겹치면 번호를 붙인다', () => {
    const imported = importLists(exportLists([store.lists[0], store.lists[0]]), ['오타']);
    expect(imported.map((l) => l.name)).toEqual(['오타 (2)', '오타 (3)']);
  });

  it('목록 하나만 담은 JSON도 받는다', () => {
    const imported = importLists(JSON.stringify({ name: '하나', rules: [{ find: 'a', flags: 'xgi' }] }), []);
    expect(imported[0].rules[0]).toMatchObject({ find: 'a', replace: '', flags: 'i', enabled: true });
  });

  it('형식이 맞지 않으면 오류', () => {
    expect(() => importLists('nope', [])).toThrow();
    expect(() => importLists('{"foo":1}', [])).toThrow();
  });
});
