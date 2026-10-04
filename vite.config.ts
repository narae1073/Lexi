import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Lexi — 단어 학습 번역기',
        short_name: 'Lexi',
        description: '모르는 단어의 뜻을 영어로 배우는 문서형 학습 도구',
        lang: 'ko',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallbackDenylist: [/^\/functions\//],
        runtimeCaching: [
          {
            /*
             * 화면 이동(HTML)은 네트워크를 먼저 본다.
             *
             * precache 는 기본이 캐시 우선이라, 한 번 받아 둔 index.html 이
             * 서버에 새 판이 생겨도 계속 옛것을 준다. 사용자는 새 버전이
             * 나왔다는 사실조차 모른다 — 실제로 그랬다. 데스크톱 브라우저에
             * 수정이 이미 반영돼 있는데도 옛 판으로 떠 있는 상황이 생겼다.
             *
             * 3초 안에 못 받으면 캐시로 물러난다. 오프라인에서도 열려야 한다.
             */
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: { cacheName: 'lexi-shell', networkTimeoutSeconds: 3 },
          },
          {
            // 번역/사전 Edge Function 응답은 캐시 가능한 GET만, POST는 캐시하지 않음
            urlPattern: /\/functions\/v1\//,
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
})