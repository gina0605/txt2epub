export type Encoding = 'auto' | 'utf-8' | 'euc-kr' | 'utf-16le' | 'utf-16be';

export interface Decoded {
  text: string;
  encoding: Exclude<Encoding, 'auto'>;
}

// UTF-8로 읽었을 때 깨진 문자(U+FFFD)가 이 비율 이하면 UTF-8로 간주한다.
// 일부만 손상된 UTF-8 파일을 EUC-KR로 잘못 읽어 전체가 깨지는 것을 막기 위함.
const MAX_BROKEN_RATIO = 0.0005;

export function decode(bytes: Uint8Array, encoding: Encoding = 'auto'): Decoded {
  if (encoding !== 'auto') {
    return { text: new TextDecoder(encoding).decode(bytes), encoding };
  }

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    const text = new TextDecoder('utf-8').decode(bytes);
    let broken = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0xfffd) broken++;
    }
    if (broken / Math.max(text.length, 1) <= MAX_BROKEN_RATIO) {
      return { text, encoding: 'utf-8' };
    }
    return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr' };
  }
}
