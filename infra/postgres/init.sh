#!/bin/bash
# Runs once when the Postgres volume is first created.
# Creates the login role the API uses at runtime. It is deliberately NOT the
# table owner and has NOBYPASSRLS, so every query it runs is subject to RLS.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE simpleride_app LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO simpleride_app;
SQL
