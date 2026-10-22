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
          source_text: string
          translated_text: string
          created_at: string
        }
        Insert: {
          source_language: string
          target_language?: string
          source_hash: string
          source_text: string
          translated_text: string
          created_at?: string
        }
        Update: {
          source_language?: string
          target_language?: string
          source_hash?: string
          source_text?: string
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
      replace_word_occurrences: {
        Args: { p_document_id: string; p_rows: Json }
        Returns: undefined
      }
    }
    Enums: { word_status: 'known' | 'unsure' | 'unknown' }
    CompositeTypes: Record<never, never>
  }
}