#!/bin/sh
# Kong's declarative config format allows $VAR-looking tokens in the YAML,
# but Kong loads the file byte-for-byte — nothing expands them. Without this
# substitution step, the anon/service_role consumers in kong.yml keep the
# literal string "$SUPABASE_ANON_KEY" as their key, so every request from
# the app (which sends the real generated key) gets a 401. This script is
# what makes the keys in .env actually match what Kong checks requests
# against.
#
# Using sed rather than envsubst: envsubst comes from the gettext package,
# which isn't guaranteed to be installed in the kong/kong image. sed is.
set -eu

: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY must be set}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY must be set}"

: "${KONG_DECLARATIVE_CONFIG:?KONG_DECLARATIVE_CONFIG must be set}"

sed \
  -e "s|\$SUPABASE_ANON_KEY|${SUPABASE_ANON_KEY}|g" \
  -e "s|\$SUPABASE_SERVICE_ROLE_KEY|${SUPABASE_SERVICE_ROLE_KEY}|g" \
  /home/kong/temp.yml > "$KONG_DECLARATIVE_CONFIG"

exec /entrypoint.sh kong docker-start
