#!/bin/sh
# Creates the Mem0 application database (users, API keys, request log) next to
# the vector database. Runs once, when the Postgres data folder is empty.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	SELECT 'CREATE DATABASE ${APP_DB_NAME:-mem0_app}'
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${APP_DB_NAME:-mem0_app}')\gexec
EOSQL
