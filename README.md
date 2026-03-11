# WCS — Warehouse Control System

A distributed system for managing autonomous mobile robot (AMR) fleets in a warehouse environment. Handles order dispatch, route optimization, and real-time robot coordination.

## Architecture

```
                        Clients
                           │
                    GraphQL (8080)
                           │
                  ┌────────▼────────┐
                  │  Fleet Gateway  │  Python · FastAPI · Strawberry
                  │   (port 8000)   │
                  └─┬───────┬───────┘
                    │       │
             ┌──────▼──┐  ┌─▼──────────────┐
             │  Redis  │  │  Kong (8000)   │  Supabase API gateway
             │  (6379) │  └─┬──────┬───────┘
             └─────────┘    │      │
                        ┌───▼──┐ ┌─▼───────┐
                        │ REST │ │ Storage │  PostgREST + Storage API
                        └───┬──┘ └─────────┘
                            │
                   ┌────────▼────────┐
                   │   PostgreSQL    │  supabase/postgres
                   │  + pgRouting    │  (port 5432)
                   └────────┬────────┘
                            │
                  ┌─────────▼─────────┐
                  │    VRP Server     │  C++ · Crow · OR-Tools
                  │    (port 18080)   │
                  └───────────────────┘

                  ROS Robots (roslibpy WebSocket)
                  ← direct TCP from Fleet Gateway →
```

## Services

| Service | Image / Build | Host Port | Description |
|---|---|---|---|
| `db` | `supabase/postgres:15.8.1.085` | 5432 | PostgreSQL with pgRouting and all Supabase extensions |
| `rest` | `postgrest/postgrest:v14.5` | — | REST API over Postgres (via Kong) |
| `meta` | `supabase/postgres-meta:v0.95.2` | — | Postgres introspection for Studio |
| `storage` | `supabase/storage-api:v1.37.8` | — | File storage API (via Kong) |
| `studio` | `supabase/studio:2026.02.16` | 54323 | Supabase Studio UI |
| `kong` | `kong:2.8.1` | 8000 | API gateway — routes `/rest/v1/`, `/storage/v1/`, `/pg/` |
| `redis` | `redis:7-alpine` | 6379 | Job queue for Fleet Gateway |
| `vrp_server` | `./vrp_server` | 18080 | Vehicle Routing Problem solver |
| `fleet_gateway` | `./fleet_gateway` | 8080 | GraphQL API for order dispatch |

## Quick Start

### 1. Configure environment

```bash
./env_init.sh
```

This generates `.env` with secure random secrets. The script interactively prompts for:
- **Robot type** — `SIMBOT` (simulator), `FACOBOT` (external), or `LOCALBOT` (host machine)
- **GraphQL IDE** — `graphiql` (default), `apollo-sandbox`, or `graphql-playground`

### 2. Start all services

```bash
docker compose up -d
```

### 3. Access

| Interface | URL |
|---|---|
| Fleet Gateway GraphQL | http://localhost:8080/graphql |
| Supabase API | http://localhost:8000 |
| Supabase Studio | http://localhost:54323 |
| VRP Server | http://localhost:18080 |

Studio login uses `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` from your `.env`.

## Repository Structure

```
wcs/
├── docker-compose.yml          # Unified stack
├── .env.example                # Environment variable template
│
├── supabase/
│   └── config.toml             # Supabase CLI config (local dev)
│
└── volumes/                    # Runtime mounts
    ├── api/kong.yml            # Kong declarative config
    ├── db/                     # Postgres init scripts
    │   ├── roles.sql           # User passwords
    │   ├── jwt.sql             # JWT settings
    │   ├── webhooks.sql        # supabase_functions schema
    │   └── _supabase.sql       # _supabase database
    ├── storage/                # Uploaded files
    ├── snippets/               # Studio SQL snippets
    └── functions/              # Studio Edge Function stubs
```

## Environment Variables

See [`.env.example`](.env.example) for the full list with descriptions.

Key variables:

| Variable | Description |
|---|---|
| `POSTGRES_PASSWORD` | Postgres superuser password |
| `JWT_SECRET` | JWT signing secret (32+ chars) |
| `ANON_KEY` | Supabase anon JWT |
| `SERVICE_ROLE_KEY` | Supabase service role JWT |
| `PG_META_CRYPTO_KEY` | postgres-meta encryption key (32+ chars) |
| `GRAPH_ID` | Warehouse graph ID used by Fleet Gateway |
| `ROBOTS_CONFIG` | JSON map of robot name → `{host, port, cell_heights}` |
| `GRAPHQL_IDE` | GraphQL IDE at `GET /graphql` — `graphiql`, `apollo-sandbox`, or `graphql-playground` |
