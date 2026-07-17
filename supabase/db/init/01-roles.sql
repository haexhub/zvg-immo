-- Vendored/trimmed from the upstream Supabase self-host init scripts.
-- Only sets passwords for the roles Phase 1 actually connects as
-- (authenticator: PostgREST, supabase_auth_admin: GoTrue). The
-- supabase/postgres image bakes in more default roles (pgbouncer,
-- supabase_storage_admin, supabase_functions_admin, ...) for services this
-- stack deliberately doesn't run — left on their baked-in defaults since
-- nothing ever authenticates as them.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
