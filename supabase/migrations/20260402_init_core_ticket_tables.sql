create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.user_tickets (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  user_id uuid unique,
  stripe_customer_id text,
  tickets integer not null default 0 check (tickets >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_tickets_email_lower_key
  on public.user_tickets (lower(email));

create index if not exists user_tickets_created_at_idx
  on public.user_tickets (created_at desc);

create index if not exists user_tickets_tickets_idx
  on public.user_tickets (tickets);

drop trigger if exists set_user_tickets_updated_at on public.user_tickets;
create trigger set_user_tickets_updated_at
before update on public.user_tickets
for each row execute function public.set_updated_at();

create table if not exists public.ticket_events (
  id bigserial primary key,
  usage_id text not null unique,
  email text not null,
  user_id uuid not null,
  delta integer not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ticket_events_user_created_idx
  on public.ticket_events (user_id, created_at desc);

create index if not exists ticket_events_email_created_idx
  on public.ticket_events (email, created_at desc);

create index if not exists ticket_events_reason_created_idx
  on public.ticket_events (reason, created_at desc);

create table if not exists public.daily_bonus_claims (
  id bigserial primary key,
  usage_id text not null unique,
  user_id uuid not null,
  email text not null,
  bonus_amount integer not null default 5 check (bonus_amount > 0),
  cooldown_hours integer not null default 24 check (cooldown_hours > 0),
  metadata jsonb not null default '{}'::jsonb,
  claimed_at timestamptz not null default now()
);

create index if not exists daily_bonus_claims_user_claimed_idx
  on public.daily_bonus_claims (user_id, claimed_at desc);

create index if not exists daily_bonus_claims_email_claimed_idx
  on public.daily_bonus_claims (email, claimed_at desc);

alter table public.user_tickets enable row level security;
alter table public.ticket_events enable row level security;
alter table public.daily_bonus_claims enable row level security;

drop policy if exists user_tickets_select_own on public.user_tickets;
create policy user_tickets_select_own
on public.user_tickets
for select
using (auth.uid() = user_id);

drop policy if exists ticket_events_select_own on public.ticket_events;
create policy ticket_events_select_own
on public.ticket_events
for select
using (auth.uid() = user_id);

drop policy if exists daily_bonus_claims_select_own on public.daily_bonus_claims;
create policy daily_bonus_claims_select_own
on public.daily_bonus_claims
for select
using (auth.uid() = user_id);

create or replace function public.consume_tickets(
  p_ticket_id uuid,
  p_usage_id text,
  p_cost integer,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb
) returns table (
  tickets_left integer,
  already_consumed boolean
) language plpgsql as $$
declare
  current_tickets integer;
  updated_tickets integer;
begin
  if p_ticket_id is null or p_usage_id is null or p_usage_id = '' then
    raise exception 'INVALID_INPUT';
  end if;
  if p_cost is null or p_cost < 1 then
    raise exception 'INVALID_COST';
  end if;

  select tickets into current_tickets
  from public.user_tickets
  where id = p_ticket_id;
  if not found then
    raise exception 'TICKET_ROW_NOT_FOUND';
  end if;

  insert into public.ticket_events (usage_id, email, user_id, delta, reason, metadata)
  select p_usage_id, email, user_id, -p_cost, p_reason, coalesce(p_metadata, '{}'::jsonb)
  from public.user_tickets
  where id = p_ticket_id
  on conflict (usage_id) do nothing;

  if not found then
    return query select current_tickets, true;
    return;
  end if;

  update public.user_tickets
  set tickets = tickets - p_cost,
      updated_at = now()
  where id = p_ticket_id
    and tickets >= p_cost
  returning tickets into updated_tickets;

  if not found then
    raise exception 'INSUFFICIENT_TICKETS';
  end if;

  return query select updated_tickets, false;
end;
$$;

create or replace function public.refund_tickets(
  p_ticket_id uuid,
  p_usage_id text,
  p_amount integer,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb
) returns table (
  tickets_left integer,
  already_refunded boolean
) language plpgsql as $$
declare
  current_tickets integer;
  updated_tickets integer;
begin
  if p_ticket_id is null or p_usage_id is null or p_usage_id = '' then
    raise exception 'INVALID_INPUT';
  end if;
  if p_amount is null or p_amount < 1 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select tickets into current_tickets
  from public.user_tickets
  where id = p_ticket_id;
  if not found then
    raise exception 'TICKET_ROW_NOT_FOUND';
  end if;

  insert into public.ticket_events (usage_id, email, user_id, delta, reason, metadata)
  select p_usage_id, email, user_id, p_amount, p_reason, coalesce(p_metadata, '{}'::jsonb)
  from public.user_tickets
  where id = p_ticket_id
  on conflict (usage_id) do nothing;

  if not found then
    return query select current_tickets, true;
    return;
  end if;

  update public.user_tickets
  set tickets = tickets + p_amount,
      updated_at = now()
  where id = p_ticket_id
  returning tickets into updated_tickets;

  if not found then
    raise exception 'TICKET_ROW_NOT_FOUND';
  end if;

  return query select updated_tickets, false;
end;
$$;

create or replace function public.grant_tickets(
  p_usage_id text,
  p_user_id uuid,
  p_email text,
  p_amount integer,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb,
  p_stripe_customer_id text default null
) returns table (
  tickets_left integer,
  already_processed boolean
) language plpgsql as $$
declare
  updated_tickets integer;
  ticket_id uuid;
begin
  if p_usage_id is null or p_usage_id = '' then
    raise exception 'INVALID_USAGE_ID';
  end if;
  if p_amount is null or p_amount < 1 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_email is null or p_email = '' then
    raise exception 'INVALID_EMAIL';
  end if;
  if p_user_id is null then
    raise exception 'INVALID_USER_ID';
  end if;

  insert into public.ticket_events (usage_id, email, user_id, delta, reason, metadata)
  values (p_usage_id, p_email, p_user_id, p_amount, p_reason, coalesce(p_metadata, '{}'::jsonb))
  on conflict (usage_id) do nothing;

  if not found then
    select tickets into updated_tickets
    from public.user_tickets
    where user_id = p_user_id or email = p_email
    limit 1;
    return query select updated_tickets, true;
    return;
  end if;

  if p_reason in ('daily_bonus', 'daily_bonus_claim') then
    insert into public.daily_bonus_claims (usage_id, user_id, email, bonus_amount, metadata)
    values (p_usage_id, p_user_id, p_email, p_amount, coalesce(p_metadata, '{}'::jsonb))
    on conflict (usage_id) do nothing;
  end if;

  select id into ticket_id
  from public.user_tickets
  where user_id = p_user_id or email = p_email
  limit 1
  for update;

  if found then
    update public.user_tickets
    set tickets = tickets + p_amount,
        user_id = coalesce(user_id, p_user_id),
        stripe_customer_id = coalesce(p_stripe_customer_id, stripe_customer_id),
        updated_at = now()
    where id = ticket_id
    returning tickets into updated_tickets;
  else
    insert into public.user_tickets (email, user_id, stripe_customer_id, tickets)
    values (p_email, p_user_id, p_stripe_customer_id, p_amount)
    returning tickets into updated_tickets;
  end if;

  return query select updated_tickets, false;
end;
$$;
