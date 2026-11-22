-- Tunisian Lifesavers : tables préfixées tl_, lecture publique, écriture via fonctions protégées par le code d'équipe.
-- Le code d'équipe est stocké haché : insert into public.tl_settings values ('edit_code_sha256', encode(extensions.digest('VOTRE-CODE', 'sha256'), 'hex'));
create table if not exists public.tl_items (
  collection text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
create table if not exists public.tl_images (
  id text primary key,
  mime text not null,
  data text not null,
  name text,
  created_at timestamptz not null default now()
);
create table if not exists public.tl_settings (
  key text primary key,
  value text not null
);

alter table public.tl_items enable row level security;
alter table public.tl_images enable row level security;
alter table public.tl_settings enable row level security;

revoke all on public.tl_items, public.tl_images, public.tl_settings from anon, authenticated;
grant select on public.tl_items, public.tl_images to anon, authenticated;

drop policy if exists tl_items_read on public.tl_items;
create policy tl_items_read on public.tl_items for select to anon, authenticated using (true);
drop policy if exists tl_images_read on public.tl_images;
create policy tl_images_read on public.tl_images for select to anon, authenticated using (true);

create or replace function public.tl_check(code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tl_settings
    where key = 'edit_code_sha256'
      and value = encode(extensions.digest(coalesce(code, ''), 'sha256'), 'hex')
  );
$$;

create or replace function public.tl_write(code text, writes jsonb default '[]'::jsonb, deletes jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  w jsonb;
  allowed text[] := array['members','meetings','actions','drives','partners','group'];
begin
  if not public.tl_check(code) then
    raise exception 'Code d''équipe incorrect' using errcode = '28000';
  end if;
  if jsonb_array_length(writes) > 50 or jsonb_array_length(deletes) > 50 then
    raise exception 'Trop d''opérations';
  end if;
  for w in select * from jsonb_array_elements(writes) loop
    if not (w->>'collection' = any(allowed)) or coalesce(w->>'id', '') = '' or length((w->'data')::text) > 200000 then
      raise exception 'Écriture invalide';
    end if;
    insert into public.tl_items (collection, id, data, updated_at)
    values (w->>'collection', w->>'id', w->'data', now())
    on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  end loop;
  for w in select * from jsonb_array_elements(deletes) loop
    delete from public.tl_items where collection = w->>'collection' and id = w->>'id';
  end loop;
end;
$$;

create or replace function public.tl_add_image(code text, img_id text, mime text, data text, name text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.tl_check(code) then
    raise exception 'Code d''équipe incorrect' using errcode = '28000';
  end if;
  if mime not in ('image/jpeg','image/png','image/webp','image/gif') or length(data) > 3000000 or img_id !~ '^img_[a-z0-9]{6,32}$' then
    raise exception 'Image invalide';
  end if;
  insert into public.tl_images (id, mime, data, name) values (img_id, mime, data, left(name, 120));
end;
$$;

revoke all on function public.tl_check(text) from public;
revoke all on function public.tl_write(text, jsonb, jsonb) from public;
revoke all on function public.tl_add_image(text, text, text, text, text) from public;
grant execute on function public.tl_check(text) to anon, authenticated;
grant execute on function public.tl_write(text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.tl_add_image(text, text, text, text, text) to anon, authenticated;
