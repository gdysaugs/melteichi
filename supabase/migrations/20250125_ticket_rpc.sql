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
