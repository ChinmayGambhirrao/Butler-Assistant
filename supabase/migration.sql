-- Add recurring flag and ensure completed_at exists
alter table tasks add column if not exists is_recurring boolean default false;
alter table tasks add column if not exists completed_at timestamptz;

-- Push subscriptions table
create table if not exists push_subscriptions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  subscription jsonb not null,
  created_at timestamptz default now(),
  unique(user_id)
);

alter table push_subscriptions enable row level security;

create policy "Users can manage their own push subscription"
  on push_subscriptions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
