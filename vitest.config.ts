import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // e2e 스펙은 vitest 가 아니라 `npm run e2e` 로 돌린다.
    // export run 만 있고 test 가 없어 vitest 가 잡으면 전부 실패로 집계된다.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
  },
})