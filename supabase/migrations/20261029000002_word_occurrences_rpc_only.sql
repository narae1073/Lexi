-- Force occurrence writes through replace_word_occurrences (R3 final review).
--
-- Direct INSERT/UPDATE/DELETE on word_occurrences bypasses the canonical hash,
-- the set-based projection refresh, and the document occurrence version. A
-- client could therefore write rows that never appear in the wordbook. The RPC
-- is SECURITY DEFINER and remains the only write path; SELECT stays available
-- for the existing incremental pull.
--
-- authenticated/anon keep SELECT (RLS still limits it to their rows). No client
-- role may write the table directly.

revoke insert, update, delete on table public.word_occurrences
  from public, anon, authenticated;
revoke select on table public.word_occurrences from public, anon;
grant select on table public.word_occurrences to authenticated;

-- The function owner (the migration role) must still be able to write, and the
-- security-definer RPC runs as that owner. Service role keeps its explicit
-- administrative access for local tooling/tests.
grant select, insert, update, delete on table public.word_occurrences to service_role;
