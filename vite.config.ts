import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages는 /저장소이름/ 아래에서 서비스되므로 상대 경로로 빌드한다
  base: './',
});
