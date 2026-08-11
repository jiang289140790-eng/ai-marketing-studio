do $migration$
begin
  if to_regclass('public.knowledge_entries') is not null then
    create policy "authenticated_read_knowledge_entries"
      on public.knowledge_entries for select to authenticated using (true);
  end if;
end
$migration$;
