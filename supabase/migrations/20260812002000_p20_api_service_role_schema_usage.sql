-- P20 forward-only repair: let the server-side Edge Function reach the
-- dedicated RPC schema without exposing that schema to browser roles.
revoke all on schema api from public, anon, authenticated;
grant usage on schema api to service_role;
revoke create on schema api from service_role;
