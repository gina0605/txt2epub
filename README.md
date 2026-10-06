# txt2epub

txt 파일을 EPUB으로 변환하는 웹 페이지. 변환은 모두 브라우저 안에서 이루어지며 파일이 서버로 전송되지 않는다.

- 첫 줄을 책 제목으로 사용
- `제1화`, `1화`, `001`, `[1화]`, `Chapter 1`, 프롤로그/외전 등 챕터 제목 자동 인식 (번호 순서로 오인식 걸러냄)
- 인코딩 자동 감지 (UTF-8 / EUC-KR / UTF-16)
- 표지 이미지 지정 (JPEG로 변환, 큰 이미지는 축소)
- 긴 챕터는 여러 파일로 나눠 리더기에서 느려지지 않게 함

## 개발

Node 20 이상 필요 (`.nvmrc` 참고).

```bash
nvm use
npm install
npm run dev      # http://localhost:5173
npm test
npm run build    # dist/ 생성
```

## 배포 (GitHub Pages)

`main` 브랜치에 push하면 GitHub Actions(`.github/workflows/deploy.yml`)가 테스트, 빌드 후 자동으로 배포한다.

처음 한 번만 설정: 저장소 Settings → Pages → Build and deployment → Source를 **GitHub Actions**로 선택.

배포 주소: `https://<아이디>.github.io/<저장소 이름>/`

## 구조

| 파일 | 역할 |
|---|---|
| `src/decode.ts` | 인코딩 감지 및 디코딩 |
| `src/parse.ts` | 제목·챕터 인식, 챕터별 본문 분리 |
| `src/epub.ts` | EPUB 파일 생성 (fflate) |
| `src/cover.ts` | 표지 이미지 리사이즈/JPEG 변환 |
| `src/worker.ts` | 무거운 작업을 처리하는 Web Worker |
| `src/main.ts` | 화면 |
