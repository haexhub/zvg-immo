-- Vendored/trimmed from the upstream Supabase self-host init scripts.
-- Only sets passwords for the roles this stack actually connects as
-- (authenticator: PostgREST, supabase_auth_admin: GoTrue,
-- supabase_storage_admin: storage-api). The supabase/postgres image creates
-- these without a password, and pg_hba requires scram-sha-256 from the
-- compose network, so a role left out here cannot log in at all. Other baked-in
-- roles (pgbouncer, supabase_functions_admin, ...) belong to services this
-- stack doesn't run and stay on their defaults. Init scripts only run on an
-- empty data volume; an existing volume needs the matching ALTER USER once by
-- hand.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
