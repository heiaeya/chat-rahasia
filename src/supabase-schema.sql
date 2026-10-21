-- Chat Berdua — Supabase schema (run once in the SQL Editor of a fresh project)
-- This exact script was used to set up the production project on 2026-10-21.
-- The app uses the anon key; privacy comes from the secret room code in the link.
create table public.messages (id text primary key, room text not null, cid text not null, name text not null, body text not null, replay_msg text, replay_name text, ts bigint not null);
create index messages_room_ts_idx on public.messages (room, ts);
alter table public.messages enable row level security;
create policy "anon read" on public.messages for select to anon using (true);
create policy "anon insert" on public.messages for insert to anon with check (true);
alter publication supabase_realtime add table public.messages;
