-- Vendored as-is from the upstream Supabase self-host init scripts. Makes
-- the JWT secret/expiry available as database settings for the `auth`
-- schema helper functions (auth.uid(), auth.role(), ...) that the
-- supabase/postgres image bundles.
\set jwt_secret `echo "$JWT_SECRET"`
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
