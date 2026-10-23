/**
 * DB 스키마 타입.
 * 검증 후 `supabase gen types typescript --local > src/lib/supabase/database.types.ts`
 * 로 재생성한다 (PLAN.md Phase 0).
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
      user_languages: {
        Row: { user_id: string; language_code: string; created_at: string }
        Insert: { user_id: string; language_code: string; created_at?: string }
        Update: { user_id?: string; language_code?: string; created_at?: string }
        Relationships: []
      }
      documents: {
        Row: {
          id: string
          user_id: string
          title: string
          language_code: string
          raw_text: string
          created_at: string
          updated_at: string
          /** 휴지통에 버린 시각. NULL 이면 살아 있는 문서 */
          deleted_at: string | null
          /** 문서가 놓인 폴더. NULL 이면 폴더에 없다 */
          folder_id: string | null
          /** 폴더로 옮긴 시각 — 열람 시각과 별개의 인장이다 */
          folder_updated_at: string | null
          /** 서버가 찍는 동기화 워터마크 */
          server_updated_at: string
          /** Canonical occurrence-set hash. NULL until the first occurrence push. */
          occurrences_hash: string | null
          /** 마지막으로 연 시각 — 내용 변경과 무관하다 */
          last_opened_at: string | null
          /** raw_text 또는 language_code 가 바뀐 시각 */
          content_updated_at: string | null
          /** 문서의 등장 기록이 바뀐 시각 */
          occurrences_updated_at: string | null
          /** char_length(raw_text) — 내용 없이 길이 표시·정렬에 쓴다 */
          char_count: number
        }
        Insert: {
          id?: string
          user_id: string
          title?: string
          language_code: string
          raw_text: string
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
          folder_id?: string | null
          folder_updated_at?: string | null
          server_updated_at?: string
          occurrences_hash?: string | null
          last_opened_at?: string | null
          content_updated_at?: string | null
          occurrences_updated_at?: string | null
          char_count?: number
        }
        Update: {
          id?: string
          user_id?: string
          title?: string
          language_code?: string
          raw_text?: string
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
          folder_id?: string | null
          folder_updated_at?: string | null
          server_updated_at?: string
          occurrences_hash?: string | null
          last_opened_at?: string | null
          content_updated_at?: string | null
          occurrences_updated_at?: string | null
          char_count?: number
        }
        Relationships: []
      }
      document_tombstones: {
        Row: {
          user_id: string
          document_id: string
          purged_at: string
          server_updated_at: string
        }
        Insert: {
          user_id: string
          document_id: string
          purged_at?: string
          server_updated_at?: string
        }
        Update: {
          user_id?: string
          document_id?: string
          purged_at?: string
          server_updated_at?: string
        }
        Relationships: []
      }
      folders: {
        Row: {
          id: string
          user_id: string
          name: string
          /** 중첩 폴더 — 최상위는 NULL */
          parent_id: string | null
          created_at: string
          updated_at: string
          deleted_at: string | null
          server_updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          parent_id?: string | null
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
          server_updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          parent_id?: string | null
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
          server_updated_at?: string
        }
        Relationships: []
      }
      word_states: {
        Row: {
          id: string
          user_id: string
          language_code: string
          lemma: string
          status: Database['public']['Enums']['word_status'] | null
          seen_count: number
          first_seen_at: string
          last_seen_at: string
          is_favorite: boolean
          favorite_updated_at: string
          star_angle: number
          star_color: string
          known_presses: number
          unsure_presses: number
          unknown_presses: number
          note: string | null
          note_updated_at: string | null
          server_updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          language_code: string
          lemma: string
          status?: Database['public']['Enums']['word_status'] | null
          seen_count?: number
          first_seen_at?: string
          last_seen_at?: string
          is_favorite?: boolean
          favorite_updated_at?: string
          star_angle?: number
          star_color?: string
          known_presses?: number
          unsure_presses?: number
          unknown_presses?: number
          note?: string | null
          note_updated_at?: string | null
          server_updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          language_code?: string
          lemma?: string
          status?: Database['public']['Enums']['word_status'] | null
          seen_count?: number
          first_seen_at?: string
          last_seen_at?: string
          is_favorite?: boolean
          favorite_updated_at?: string
          star_angle?: number
          star_color?: string
          known_presses?: number
          unsure_presses?: number
          unknown_presses?: number
          note?: string | null
          note_updated_at?: string | null
          server_updated_at?: string
        }
        Relationships: []
      }
      wordbook_entries: {
        Row: {
          user_id: string
          language_code: string
          lemma: string
          /** 이 lemma 의 서로 다른 표기들 */
          surfaces: string[]
          /** [{ documentId, sentence }] — 빈 문장은 제외 */
          contexts: Json
          /** 문서별 (document_id, lemma) 횟수를 한 번씩만 더한 값 */
          occurrence_count: number
          document_count: number
          status: Database['public']['Enums']['word_status'] | null
          is_favorite: boolean
          star_angle: number
          star_color: string
          seen_count: number
          first_seen_at: string | null
          last_seen_at: string | null
          favorite_updated_at: string | null
          known_presses: number
          unsure_presses: number
          unknown_presses: number
          note: string | null
          note_updated_at: string | null
          /** 마지막 등장이 사라진 시각. NULL 이면 살아 있는 항목 */
          deleted_at: string | null
          /** 서버가 찍는 동기화 워터마크 */
          server_updated_at: string
        }
        Insert: {
          user_id: string
          language_code: string
          lemma: string
          surfaces?: string[]
          contexts?: Json
          occurrence_count?: number
          document_count?: number
          status?: Database['public']['Enums']['word_status'] | null
          is_favorite?: boolean
          star_angle?: number
          star_color?: string
          seen_count?: number
          first_seen_at?: string | null
          last_seen_at?: string | null
          favorite_updated_at?: string | null
          known_presses?: number
          unsure_presses?: number
          unknown_presses?: number
          note?: string | null
          note_updated_at?: string | null
          deleted_at?: string | null
          server_updated_at?: string
        }
        Update: {
          user_id?: string
          language_code?: string
          lemma?: string
          surfaces?: string[]
          contexts?: Json
          occurrence_count?: number
          document_count?: number
          status?: Database['public']['Enums']['word_status'] | null
          is_favorite?: boolean
          star_angle?: number
          star_color?: string
          seen_count?: number
          first_seen_at?: string | null
          last_seen_at?: string | null
          favorite_updated_at?: string | null
          known_presses?: number
          unsure_presses?: number
          unknown_presses?: number
          note?: string | null
          note_updated_at?: string | null
          deleted_at?: string | null
          server_updated_at?: string
        }
        Relationships: []
      }
      word_occurrences: {
        Row: {
          id: number
          user_id: string
          document_id: string
          language_code: string
          lemma: string
          surface: string
          char_start: number
          char_end: number
          sentence: string
          /** 이 표기가 등장한 횟수 */
          occurrences_count: number
        }
        Insert: {
          id?: never
          user_id: string
          document_id: string
          language_code: string
          lemma: string
          surface: string
          char_start: number
          char_end: number
          sentence: string
          occurrences_count?: number
        }
        Update: {
          id?: never
          user_id?: string
          document_id?: string
          language_code?: string
          lemma?: string
          surface?: string
          char_start?: number
          char_end?: number
          sentence?: string
          occurrences_count?: number
        }
        Relationships: []
      }
      translation_cache: {
        Row: {
          source_language: string
          target_language: string
          source_hash: string
          translated_text: string
          created_at: string
        }
        Insert: {
          source_language: string
          target_language?: string
          source_hash: string
          translated_text: string
          created_at?: string
        }
        Update: {
          source_language?: string
          target_language?: string
          source_hash?: string
          translated_text?: string
          created_at?: string
        }
        Relationships: []
      }
      dictionary_entries: {
        Row: {
          language_code: string
          lemma: string
          target_language: string
          payload: Json
          provider: string
          fetched_at: string
        }
        Insert: {
          language_code: string
          lemma: string
          target_language?: string
          payload: Json
          provider: string
          fetched_at?: string
        }
        Update: {
          language_code?: string
          lemma?: string
          target_language?: string
          payload?: Json
          provider?: string
          fetched_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<never, never>
    Functions: {
      sync_snapshot: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      replace_word_occurrences: {
        Args: { p_document_id: string; p_rows: Json }
        Returns: undefined
      }
    }
    Enums: { word_status: 'known' | 'unsure' | 'unknown' }
    CompositeTypes: Record<never, never>
  }
}
