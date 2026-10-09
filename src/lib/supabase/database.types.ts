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
        }
        Relationships: []
      }
      word_states: {
        Row: {
          id: string
          user_id: string
          language_code: string
          lemma: string
          status: Database['public']['Enums']['word_status']
          seen_count: number
          first_seen_at: string
          last_seen_at: string
          is_favorite: boolean
          favorite_updated_at: string
          star_angle: number
          star_color: string
        }
        Insert: {
          id?: string
          user_id: string
          language_code: string
          lemma: string
          status?: Database['public']['Enums']['word_status']
          seen_count?: number
          first_seen_at?: string
          last_seen_at?: string
          is_favorite?: boolean
          favorite_updated_at?: string
          star_angle?: number
          star_color?: string
        }
        Update: {
          id?: string
          user_id?: string
          language_code?: string
          lemma?: string
          status?: Database['public']['Enums']['word_status']
          seen_count?: number
          first_seen_at?: string
          last_seen_at?: string
          is_favorite?: boolean
          favorite_updated_at?: string
          star_angle?: number
          star_color?: string
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
          payload: Json
          provider: string
          fetched_at: string
        }
        Insert: {
          language_code: string
          lemma: string
          payload: Json
          provider: string
          fetched_at?: string
        }
        Update: {
          language_code?: string
          lemma?: string
          payload?: Json
          provider?: string
          fetched_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<never, never>
    Functions: Record<never, never>
    Enums: { word_status: 'known' | 'unsure' | 'unknown' }
    CompositeTypes: Record<never, never>
  }
}