/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** '1' 로 두면 Google 로그인 버튼을 보여 준다 (Supabase 콘솔에서 provider 를 켠 뒤에만) */
  readonly VITE_SHOW_GOOGLE_LOGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}