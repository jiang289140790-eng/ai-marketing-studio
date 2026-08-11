-- Context AI and production binding updates are initiated by the authenticated
-- owner from the online workspace. Keep the policy owner-scoped and preserve
-- the service-role policy used by trusted backend workflows.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'content_packages'
      and policyname = 'content_packages_update_own'
  ) then
    create policy "content_packages_update_own"
      on public.content_packages
      for update
      to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;
end
$$;
