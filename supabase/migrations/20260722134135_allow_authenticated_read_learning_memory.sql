do $migration$
begin
  if to_regclass('public.content_memory') is not null then
    create policy "authenticated_read_content_memory"
      on public.content_memory for select to authenticated using (true);
  end if;
  if to_regclass('public.strategy_memory') is not null then
    create policy "authenticated_read_strategy_memory"
      on public.strategy_memory for select to authenticated using (true);
  end if;
end
$migration$;
