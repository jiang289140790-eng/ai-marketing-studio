create schema if not exists ams_private;
create schema if not exists api;

revoke all on schema ams_private from public, anon, authenticated;
revoke all on schema api from public, anon, authenticated;
revoke create on schema ams_private from service_role;
revoke create on schema api from service_role;

alter default privileges for role postgres in schema ams_private revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema ams_private revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema ams_private revoke all on functions from public, anon, authenticated;
alter default privileges for role postgres in schema api revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema api revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema api revoke all on functions from public, anon, authenticated;

comment on schema ams_private is 'P17 private storage schema; never add to Data API exposed schemas.';
comment on schema api is 'P17 explicitly granted read-only API views; exposure requires a separate staging authorization.';
