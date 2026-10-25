create extension if not exists pgcrypto with schema extensions;

create table if not exists public.bb_rooms (
  code text primary key check (code ~ '^[A-HJ-NP-Z2-9]{5}$'),
  host_id uuid not null,
  phase text not null default 'waiting' check (phase in ('waiting', 'answering', 'voting', 'results', 'finished')),
  round_no integer not null default 0 check (round_no between 0 and 3),
  created_at timestamptz not null default now()
);

create table if not exists public.bb_players (
  id uuid primary key,
  room_code text not null references public.bb_rooms(code) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  token_hash text not null unique,
  score integer not null default 0,
  correct_guesses integer not null default 0,
  bluff_votes integer not null default 0,
  joined_at timestamptz not null default now()
);

alter table public.bb_rooms
  drop constraint if exists bb_rooms_host_id_fkey;
alter table public.bb_rooms
  add constraint bb_rooms_host_id_fkey foreign key (host_id) references public.bb_players(id) deferrable initially deferred;

create table if not exists public.bb_rounds (
  room_code text not null references public.bb_rooms(code) on delete cascade,
  round_no integer not null check (round_no between 1 and 3),
  question text not null,
  correct_answer text not null,
  submissions jsonb not null default '{}'::jsonb,
  votes jsonb not null default '{}'::jsonb,
  answers jsonb not null default '[]'::jsonb,
  primary key (room_code, round_no)
);

alter table public.bb_rooms enable row level security;
alter table public.bb_players enable row level security;
alter table public.bb_rounds enable row level security;
revoke all on public.bb_rooms, public.bb_players, public.bb_rounds from anon, authenticated;

create or replace function public.bb_create_room(p_code text, p_player_id uuid, p_name text, p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_code !~ '^[A-HJ-NP-Z2-9]{5}$' then raise exception 'Invalid room code.'; end if;
  if length(trim(p_name)) not between 1 and 20 then raise exception 'Names must be between 1 and 20 characters.'; end if;
  if length(p_token) < 32 then raise exception 'Invalid player session.'; end if;
  insert into bb_rooms(code, host_id) values (p_code, p_player_id);
  insert into bb_players(id, room_code, name, token_hash)
  values (p_player_id, p_code, trim(p_name), encode(digest(p_token, 'sha256'), 'hex'));
end;
$$;

create or replace function public.bb_join_room(p_code text, p_player_id uuid, p_name text, p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  room_phase text;
  player_count integer;
begin
  if length(trim(p_name)) not between 1 and 20 then raise exception 'Names must be between 1 and 20 characters.'; end if;
  select phase into room_phase from bb_rooms where code = p_code for update;
  if not found then raise exception 'Room not found. Check the code and try again.'; end if;
  if room_phase <> 'waiting' then raise exception 'This game has already started.'; end if;
  select count(*) into player_count from bb_players where room_code = p_code;
  if player_count >= 8 then raise exception 'This room is full (8 players maximum).'; end if;
  insert into bb_players(id, room_code, name, token_hash)
  values (p_player_id, p_code, trim(p_name), encode(digest(p_token, 'sha256'), 'hex'));
end;
$$;

create or replace function public.bb_leave_room(p_code text, p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid;
  room_row bb_rooms%rowtype;
begin
  me := bb_player_id(p_code, p_token);
  select * into room_row from bb_rooms where code = p_code for update;
  if not found then raise exception 'Room not found. Check the code and try again.'; end if;
  if room_row.phase <> 'waiting' then raise exception 'Players cannot leave after a game has started.'; end if;
  if room_row.host_id = me then
    delete from bb_rooms where code = p_code;
  else
    delete from bb_players where id = me;
  end if;
end;
$$;

create or replace function public.bb_player_id(p_code text, p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  found_id uuid;
begin
  select id into found_id from bb_players
  where room_code = p_code and token_hash = encode(digest(p_token, 'sha256'), 'hex');
  if found_id is null then raise exception 'Player session not found. Return home and rejoin the room.'; end if;
  return found_id;
end;
$$;

create or replace function public.bb_game_state(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  room_row bb_rooms%rowtype;
  me uuid;
  current_round bb_rounds%rowtype;
  player_data jsonb;
  visible_answers jsonb := '[]'::jsonb;
  visible_votes jsonb := '[]'::jsonb;
begin
  me := bb_player_id(p_code, p_token);
  select * into room_row from bb_rooms where code = p_code;
  if not found then raise exception 'Room not found. Check the code and try again.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'score', p.score,
    'correct', p.correct_guesses, 'fooled', p.bluff_votes,
    'host', p.id = room_row.host_id
  ) order by p.joined_at), '[]'::jsonb) into player_data
  from bb_players p where p.room_code = p_code;
  if room_row.round_no > 0 then
    select * into current_round from bb_rounds where room_code = p_code and round_no = room_row.round_no;
    if room_row.phase in ('voting', 'results', 'finished') then
      if room_row.phase in ('voting') then
        select coalesce(jsonb_agg(jsonb_build_object('id', answer->>'id', 'text', answer->>'text') order by ord), '[]'::jsonb)
          into visible_answers from jsonb_array_elements(current_round.answers) with ordinality as items(answer, ord);
      else
        visible_answers := current_round.answers;
        select coalesce(jsonb_agg(jsonb_build_object('voterId', key, 'answerId', value)), '[]'::jsonb)
          into visible_votes from jsonb_each_text(current_round.votes);
      end if;
    end if;
    return jsonb_build_object(
      'code', p_code, 'phase', room_row.phase, 'round', room_row.round_no, 'me', me,
      'host', room_row.host_id, 'players', player_data,
      'question', current_round.question,
      'submitted', coalesce((select jsonb_agg(key) from jsonb_each(current_round.submissions)), '[]'::jsonb),
      'voted', coalesce((select jsonb_agg(key) from jsonb_each(current_round.votes)), '[]'::jsonb),
      'answers', visible_answers, 'votes', visible_votes
    );
  end if;
  return jsonb_build_object(
    'code', p_code, 'phase', room_row.phase, 'round', room_row.round_no, 'me', me,
    'host', room_row.host_id, 'players', player_data
  );
end;
$$;

create or replace function public.bb_start_round(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid;
  room_row bb_rooms%rowtype;
  question_data jsonb;
  question_pool jsonb[];
  question_index integer;
  next_round integer;
begin
  me := bb_player_id(p_code, p_token);
  select * into room_row from bb_rooms where code = p_code for update;
  if not found then raise exception 'Room not found. Check the code and try again.'; end if;
  if room_row.host_id <> me then raise exception 'Only the host can start the game or next round.'; end if;
  if room_row.phase not in ('waiting', 'results') then raise exception 'The game cannot advance right now.'; end if;
  if room_row.phase = 'waiting' and (select count(*) from bb_players where room_code = p_code) < 2 then
    raise exception 'At least 2 players are needed to start.';
  end if;
  if room_row.round_no >= 3 then raise exception 'All 3 rounds are complete.'; end if;
  next_round := room_row.round_no + 1;
  question_pool := array[
    '{"question":"Which mammal can truly fly?","answer":"A bat"}'::jsonb,
    '{"question":"What is the largest ocean on Earth?","answer":"The Pacific Ocean"}'::jsonb,
    '{"question":"How many hearts does an octopus have?","answer":"Three"}'::jsonb,
    '{"question":"At sea level, what is the boiling point of water in Celsius?","answer":"100 degrees"}'::jsonb,
    '{"question":"What is the only even prime number?","answer":"2"}'::jsonb,
    '{"question":"How many dots are there on a standard six-sided die in total?","answer":"21"}'::jsonb,
    '{"question":"What is the fastest land animal?","answer":"The cheetah"}'::jsonb,
    '{"question":"How many strings does a standard violin have?","answer":"Four"}'::jsonb,
    '{"question":"What is the capital city of Iceland?","answer":"Reykjavik"}'::jsonb,
    '{"question":"What color do you get by mixing blue and yellow paint?","answer":"Green"}'::jsonb
  ];
  select choice.index into question_index
  from generate_subscripts(question_pool, 1) as choice(index)
  where not exists (
    select 1 from bb_rounds previous
    where previous.room_code = p_code
      and previous.question = question_pool[choice.index]->>'question'
  )
  order by random()
  limit 1;
  question_data := question_pool[question_index];
  insert into bb_rounds(room_code, round_no, question, correct_answer)
  values (p_code, next_round, question_data->>'question', question_data->>'answer');
  update bb_rooms set round_no = next_round, phase = 'answering' where code = p_code;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.bb_submit_answer(p_code text, p_token text, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid;
  room_row bb_rooms%rowtype;
  current_round bb_rounds%rowtype;
  total_players integer;
  answer_list jsonb;
begin
  me := bb_player_id(p_code, p_token);
  select * into room_row from bb_rooms where code = p_code for update;
  if not found or room_row.phase <> 'answering' then raise exception 'Answer submissions are closed.'; end if;
  if length(trim(p_answer)) not between 1 and 120 then raise exception 'Your bluff must be between 1 and 120 characters.'; end if;
  select * into current_round from bb_rounds where room_code = p_code and round_no = room_row.round_no;
  if current_round.submissions ? me::text then raise exception 'You already submitted an answer this round.'; end if;
  update bb_rounds set submissions = submissions || jsonb_build_object(me::text, trim(p_answer))
    where room_code = p_code and round_no = room_row.round_no;
  select count(*) into total_players from bb_players where room_code = p_code;
  if (select count(*) from jsonb_each(current_round.submissions || jsonb_build_object(me::text, trim(p_answer)))) = total_players then
    select coalesce(jsonb_agg(choice.answer order by random()), '[]'::jsonb) into answer_list
    from jsonb_array_elements(
      jsonb_build_array(jsonb_build_object(
        'id', 'real', 'text', current_round.correct_answer, 'authorId', null, 'correct', true
      )) || coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id::text, 'text', submissions.value, 'authorId', p.id::text, 'correct', false
        ) order by random())
        from bb_players p
        join jsonb_each_text(current_round.submissions || jsonb_build_object(me::text, trim(p_answer))) submissions
          on submissions.key = p.id::text
        where p.room_code = p_code
      ), '[]'::jsonb)
    ) as choice(answer);
    update bb_rounds set answers = answer_list where room_code = p_code and round_no = room_row.round_no;
    update bb_rooms set phase = 'voting' where code = p_code;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.bb_cast_vote(p_code text, p_token text, p_answer_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid;
  room_row bb_rooms%rowtype;
  current_round bb_rounds%rowtype;
  vote_count integer;
  total_players integer;
  new_votes jsonb;
begin
  me := bb_player_id(p_code, p_token);
  select * into room_row from bb_rooms where code = p_code for update;
  if not found or room_row.phase <> 'voting' then raise exception 'Voting is closed.'; end if;
  select * into current_round from bb_rounds where room_code = p_code and round_no = room_row.round_no;
  if current_round.votes ? me::text then raise exception 'You already voted this round.'; end if;
  if not exists (select 1 from jsonb_array_elements(current_round.answers) answer where answer->>'id' = p_answer_id) then
    raise exception 'That answer is not available for voting.';
  end if;
  if p_answer_id = me::text then raise exception 'You cannot vote for your own bluff.'; end if;
  new_votes := current_round.votes || jsonb_build_object(me::text, p_answer_id);
  update bb_rounds set votes = new_votes where room_code = p_code and round_no = room_row.round_no;
  select count(*) into vote_count from jsonb_each(new_votes);
  select count(*) into total_players from bb_players where room_code = p_code;
  if vote_count = total_players then
    update bb_players player set
      score = score
        + case when new_votes->>(player.id::text) = 'real' then 1 else 0 end
        + (select count(*) from jsonb_each_text(new_votes) vote where vote.value = player.id::text),
      correct_guesses = correct_guesses + case when new_votes->>(player.id::text) = 'real' then 1 else 0 end,
      bluff_votes = bluff_votes + (select count(*) from jsonb_each_text(new_votes) vote where vote.value = player.id::text)
    where player.room_code = p_code;
    update bb_rooms set phase = case when round_no = 3 then 'finished' else 'results' end where code = p_code;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.bb_create_room(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.bb_join_room(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.bb_leave_room(text, text) from public, anon, authenticated;
revoke all on function public.bb_player_id(text, text) from public, anon, authenticated;
revoke all on function public.bb_game_state(text, text) from public, anon, authenticated;
revoke all on function public.bb_start_round(text, text) from public, anon, authenticated;
revoke all on function public.bb_submit_answer(text, text, text) from public, anon, authenticated;
revoke all on function public.bb_cast_vote(text, text, text) from public, anon, authenticated;
grant execute on function public.bb_create_room(text, uuid, text, text) to service_role;
grant execute on function public.bb_join_room(text, uuid, text, text) to service_role;
grant execute on function public.bb_leave_room(text, text) to service_role;
grant execute on function public.bb_player_id(text, text) to service_role;
grant execute on function public.bb_game_state(text, text) to service_role;
grant execute on function public.bb_start_round(text, text) to service_role;
grant execute on function public.bb_submit_answer(text, text, text) to service_role;
grant execute on function public.bb_cast_vote(text, text, text) to service_role;
