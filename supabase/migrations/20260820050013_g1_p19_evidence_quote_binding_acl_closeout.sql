-- G1 P19 Evidence quote-binding ACL forward closeout.
-- These SECURITY DEFINER helpers are internal to the owner-controlled G1
-- quote/submit path. PostgreSQL grants function EXECUTE to PUBLIC by default,
-- so revoke all client roles explicitly and retain only service_role access.

revoke execute on function ams_private.g1_resolve_evidence_binding(uuid, text, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function ams_private.g1_normalize_request(uuid, jsonb)
  from public, anon, authenticated;

grant execute on function ams_private.g1_resolve_evidence_binding(uuid, text, jsonb, jsonb, jsonb, jsonb)
  to service_role;
grant execute on function ams_private.g1_normalize_request(uuid, jsonb)
  to service_role;
