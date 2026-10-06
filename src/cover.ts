import type { Cover } from './epub';

// 리더기 표지로 충분한 크기. 이보다 크면 줄여서 EPUB 용량을 아낀다.
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 2560;

/** 어떤 형식의 이미지든 JPEG로 바꾸고 너무 크면 줄인다. (EPUB 리더 호환성이 가장 좋은 형식) */
export async function prepareCover(file: Blob): Promise<Cover & { blob: Blob }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // 투명 PNG가 검게 나오지 않도록
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('표지 이미지를 변환하지 못했습니다.'))), 'image/jpeg', 0.9),
  );
  return { data: new Uint8Array(await blob.arrayBuffer()), width, height, blob };
}
