import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages는 /저장소이름/ 아래에서 서비스되므로 상대 경로로 빌드한다
  base: './',
  build: {
    rollupOptions: {
      // 페이지마다 html 파일을 하나씩 둔다
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        replace: fileURLToPath(new URL('./replace/index.html', import.meta.url)),
      },
    },
  },
});
