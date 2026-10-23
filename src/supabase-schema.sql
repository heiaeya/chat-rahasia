-- ChatVI — Supabase schema v2 (run once in the SQL Editor of a fresh project)
-- Security model: the anon key can INSERT messages and can read ONLY through
-- get_messages(p_room) — i.e. only when it already knows the secret room code.
-- There is deliberately NO direct select policy on the table, so nobody can
-- dump other rooms. Realtime delivery uses Realtime Broadcast on a per-room
-- channel (whose name contains the room code), not postgres_changes.
create table public.messages (id text primary key, room text not null, cid text not null, name text not null, body text not null, replay_msg text, replay_name text, ts bigint not null);
create index messages_room_ts_idx on public.messages (room, ts);
alter table public.messages enable row level security;
create policy "anon insert" on public.messages for insert to anon with check (true);
create or replace function public.get_messages(p_room text)
returns setof public.messages
language sql
security definer
set search_path = public
as $$ select * from public.messages where room = p_room order by ts asc limit 500 $$;
grant execute on function public.get_messages(text) to anon;

-- Lockdown step for EXISTING (v1) projects that still have the old read policy:
--   drop policy "anon read" on public.messages;
-- Run it only AFTER the v4 app (RPC history + broadcast realtime) is deployed.

-- ===== Fitur kirim foto (Supabase Storage) =====
-- Bucket publik "photos" + izin baca publik & upload untuk anon.
-- URL foto tidak bisa ditebak (mengandung kode room + id acak), sama seperti model link room.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

create policy "chat6 photos read" on storage.objects
for select to anon, authenticated
using (bucket_id = 'photos');

create policy "chat6 photos upload" on storage.objects
for insert to anon, authenticated
with check (bucket_id = 'photos');
