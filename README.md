# txt2epub

txt 파일을 EPUB으로 변환하고, 기존 EPUB의 표지·정보·챕터를 고치는 웹 페이지. txt·epub의 텍스트를 정규식 목록으로 대치하는 페이지도 함께 있다. 변환은 모두 브라우저 안에서 이루어지며 파일이 서버로 전송되지 않는다.

- 첫 줄을 책 제목으로 사용
- `제1화`, `1화`, `001`, `[1화]`, `Chapter 1`, 프롤로그/외전 등 챕터 제목 자동 인식 (번호 순서로 오인식 걸러냄)
- 인코딩 자동 감지 (UTF-8 / EUC-KR / UTF-16)
- 표지 이미지 지정 (JPEG로 변환, 큰 이미지는 축소)
- 긴 챕터는 여러 파일로 나눠 리더기에서 느려지지 않게 함
- EPUB 입력: 표지 추가/교체, 제목·저자 수정, 챕터 다시 나누기
  - 챕터를 원래 목차 그대로 두면 원본 본문·서식·이미지를 유지한 채 정보와 표지만 수정
  - 챕터를 바꾸면 본문을 텍스트로 꺼내 EPUB을 새로 만듦 (원본 서식·이미지는 사라짐)

### 텍스트 대치 (`/replace/`)

txt·epub 파일의 글자를 정규식 규칙 목록으로 한꺼번에 바꾼다.

- 규칙은 위에서부터 차례로 적용 (`g`, `m` 플래그 항상 사용, `i`·`s` 선택)
- 바꿀 내용에 `$1`, `$<이름>`, `$&`, `\n`, `\t` 사용 가능
- 규칙 목록을 여러 개 만들어 브라우저(localStorage)에 자동 저장, JSON 파일로 내보내기/가져오기
- 규칙별 바뀐 개수와 예시 표시
- txt는 UTF-8로 저장 (줄바꿈 방식은 원본 유지), EPUB은 본문·목차의 글자만 바꾸고 태그·서식·이미지는 유지
- EPUB은 적용 범위를 목차 기준 챕터 하나로 좁힐 수 있음 (그 챕터의 본문과 목차 속 제목만 바뀜)
- Web Worker에서 처리하므로 수십 MB 파일이나 오래 걸리는 정규식에도 화면이 멈추지 않고, 중지할 수 있음

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
| `src/epubRead.ts` | EPUB 읽기 (텍스트·목차·표지·챕터별 파일 추출), 원본 유지 수정 |
| `src/cover.ts` | 표지 이미지 리사이즈/JPEG 변환 |
| `src/worker.ts` | 무거운 작업을 처리하는 Web Worker |
| `src/main.ts` | 화면 |
| `replace/index.html` | 텍스트 대치 페이지 |
| `src/replace/substitute.ts` | 정규식 대치 (txt 전체, XHTML·NCX의 글자 부분), EPUB 다시 묶기 |
| `src/replace/rules.ts` | 규칙 목록 저장/불러오기, 파일 내보내기/가져오기 |
| `src/replace/worker.ts` | 대치 작업을 처리하는 Web Worker |
| `src/replace/main.ts` | 텍스트 대치 화면 |
