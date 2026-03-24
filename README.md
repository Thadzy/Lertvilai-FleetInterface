# WCS — Warehouse Control System

A distributed system for managing autonomous mobile robot (AMR) fleets in a warehouse. Handles order dispatch, route optimization, and real-time robot coordination via ROS2.

## Architecture

```
                     Client (browser / curl)
                              │
                    GraphQL  http://localhost:8080/graphql
                              │
               ┌──────────────▼──────────────┐
               │        Fleet Gateway        │  Python · FastAPI · Strawberry GraphQL
               │         (port 8080)         │  reads robot state from Redis
               └──────┬───────────┬──────────┘
                      │           │
              ┌───────▼───┐   ┌───▼───────────────────┐
              │   Redis   │   │    Kong  (port 8000)   │  Supabase API gateway
              │  (6379)   │   └───┬───────────┬────────┘
              └───────────┘       │           │
                            ┌─────▼──┐  ┌─────▼────┐
                            │  REST  │  │ Storage  │  PostgREST + Storage API
                            └─────┬──┘  └──────────┘
                                  │
                         ┌────────▼────────┐
                         │   PostgreSQL    │  supabase/postgres:15.8
                         │  + pgRouting   │  (port 5432)
                         └────────┬────────┘
                                  │
                        ┌─────────▼─────────┐
                        │    VRP Server     │  C++ · Crow · OR-Tools
                        │    (port 18080)   │
                        └───────────────────┘

         robot_bridge ──────► Redis ◄────── Fleet Gateway
              │
              ▼ WebSocket (rosbridge)
         robot_simulator (port 9090)   ← ROS2 topics
```

## Services

| Service | Image / Build | Host Port | Description |
|---|---|---|---|
| `db` | `supabase/postgres:15.8.1.085` | 5432 | PostgreSQL with pgRouting and all Supabase extensions |
| `rest` | `postgrest/postgrest:v14.5` | — (via Kong) | REST API over Postgres |
| `meta` | `supabase/postgres-meta:v0.95.2` | — | Postgres introspection for Studio |
| `storage` | `supabase/storage-api:v1.37.8` | — | File storage API |
| `studio` | `supabase/studio:2026.02.16` | 54323 | Supabase Studio UI |
| `kong` | `kong:2.8.1` | 8000 / 8443 | API gateway |
| `redis` | `redis:7-alpine` | 6379 | Robot state store + pub/sub |
| `vrp_server` | `journeykmutt/vrp_server:latest` | 18080 | Vehicle Routing Problem solver |
| `fleet_gateway` | `./fleet_gateway_custom` | 8080 | GraphQL API for robot control |
| `robot_simulator` | `journeykmutt/robot_simulator:latest` | 9090 | ROS2 rosbridge WebSocket simulator |
| `robot_bridge` | `./robot_bridge` | — | Bridges ROS2 topics → Redis |

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose plugin)
- Git

---

## Quick Start

### 1. Clone and enter the directory

```bash
git clone <repo-url>
cd wcs
```

### 2. Generate environment config

```bash
./env_init.sh
```

This creates `.env` with secure random secrets. The script prompts for:
- **Robot type** — choose `SIMBOT` (uses built-in simulator, recommended for first run)
- **GraphQL IDE** — choose `graphiql` (default)

If `env_init.sh` is not executable:
```bash
chmod +x env_init.sh && ./env_init.sh
```

> **Alternatively**, copy and edit manually:
> ```bash
> cp .env.example .env
> # Edit .env — at minimum set POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY
> ```

### 3. Start all services

```bash
docker compose up -d
```

First run pulls all images and builds local services (~2–5 min depending on connection).

### 4. Load warehouse graph data

After DB is healthy, load a sample warehouse layout:

```bash
# Option A — small dummy layout (fast, for testing)
docker exec -i wcs-db-1 psql -U postgres < db_schema/graph_layout/sample_dummy.sql

# Option B — real FIBO 6-floor warehouse layout
docker exec -i wcs-db-1 psql -U postgres < db_schema/graph_layout/sample_fibo_6fl.sql
```

> The DB container name may differ. Check with: `docker ps --format 'table {{.Names}}'`

### 5. Access the services

| Interface | URL | Credentials |
|---|---|---|
| Fleet Gateway GraphQL | http://localhost:8080/graphql | — |
| Supabase API (Kong) | http://localhost:8000 | — |
| Supabase Studio | http://localhost:54323 | `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` from `.env` |
| VRP Server | http://localhost:18080/health | — |
| Robot Simulator (rosbridge) | ws://localhost:9090 | — |

---

## Verifying the Setup

Open http://localhost:8080/graphql and run:

```graphql
query {
  robots {
    name
    connectionStatus
    lastActionStatus
    mobileBaseState {
      pose { x y a timestamp }
      tag { qrId timestamp }
    }
  }
}
```

Expected result (SIMBOT in simulation mode):
```json
{
  "data": {
    "robots": [
      {
        "name": "SIMBOT",
        "connectionStatus": "ONLINE",
        "lastActionStatus": "IDLE",
        "mobileBaseState": {
          "pose": { "x": 1.234, "y": 5.678, "a": 0.0, "timestamp": "..." },
          "tag": { "qrId": "Q5", "timestamp": "..." }
        }
      }
    ]
  }
}
```

---

## Repository Structure

```
wcs/
├── docker-compose.yml              # Full service stack
├── .env.example                    # Environment variable template
├── env_init.sh                     # Interactive setup script
│
├── fleet_gateway_custom/           # Custom Fleet Gateway (FastAPI + GraphQL)
│   ├── Dockerfile
│   ├── requirements.txt
│   └── main.py                     # GraphQL schema + Redis reader
│
├── robot_bridge/                   # ROS2 → Redis bridge
│   ├── Dockerfile
│   ├── requirements.txt
│   └── main.py                     # rosbridge WebSocket → Redis
│
├── db_schema/
│   ├── graph.sql                   # Compiled master (run this to init schema)
│   ├── graph/                      # Individual schema files
│   │   ├── tables.sql
│   │   ├── functions.sql           # pgRouting wrappers (wh_astar_*)
│   │   ├── views.sql
│   │   ├── indexes.sql
│   │   ├── triggers.sql
│   │   ├── types.sql
│   │   └── permissions.sql
│   └── graph_layout/
│       ├── sample_dummy.sql        # Minimal layout for quick testing
│       └── sample_fibo_6fl.sql     # Full FIBO 6-floor warehouse layout
│
└── volumes/
    ├── api/kong.yml                # Kong declarative config
    ├── db/                         # Postgres init SQL (roles, JWT, webhooks)
    └── db/init/00-extensions.sql   # Enables pgRouting extension
```

---

## Environment Variables

Key variables in `.env`:

| Variable | Description | Default |
|---|---|---|
| `POSTGRES_PASSWORD` | Postgres superuser password | *(required)* |
| `JWT_SECRET` | JWT signing secret (min 32 chars) | *(required)* |
| `ANON_KEY` | Supabase anon JWT | *(required)* |
| `SERVICE_ROLE_KEY` | Supabase service role JWT | *(required)* |
| `PG_META_CRYPTO_KEY` | postgres-meta encryption key (min 32 chars) | *(required)* |
| `DASHBOARD_USERNAME` | Supabase Studio login | `supabase` |
| `DASHBOARD_PASSWORD` | Supabase Studio password | `supabase` |
| `ROBOTS_CONFIG` | Robot fleet JSON config (see below) | SIMBOT |
| `GRAPHQL_IDE` | IDE at `GET /graphql` | `graphiql` |
| `GRAPH_ID` | Active warehouse graph ID | `1` |

To generate `ANON_KEY` and `SERVICE_ROLE_KEY` from your `JWT_SECRET`:
```bash
npx supabase@latest gen keys --project-ref local
```
Or use: https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys

---

## Robot Configuration

### SIMBOT (built-in simulator — default)

No extra setup needed. Uses `robot_simulator` container + `robot_bridge`.

`.env`:
```
ROBOTS_CONFIG='{"SIMBOT": {"host": "robot_simulator", "port": 9090, "cell_heights": [0.653, 1.073, 1.493, 1.913]}}'
```

### FACOBOT (external robot on the network)

```
ROBOTS_CONFIG='{"FACOBOT": {"host": "10.61.6.65", "port": 9090, "cell_heights": [0.653, 1.073, 1.493, 1.913]}}'
```

Comment out `robot_simulator` and `robot_bridge` services in `docker-compose.yml` if not using simulation.

### LOCALBOT (robot on host machine)

```
ROBOTS_CONFIG='{"LOCALBOT": {"host": "host.docker.internal", "port": 9090, "cell_heights": [0.653, 1.073, 1.493, 1.913]}}'
```

`cell_heights` = shelf cell heights in meters (one value per level, bottom to top).

---

## GraphQL API Reference

**Endpoint:** `http://localhost:8080/graphql`

### Queries

```graphql
# List all robots and their live state
query {
  robots {
    name
    connectionStatus       # ONLINE | OFFLINE
    lastActionStatus       # IDLE | RUNNING | ERROR
    mobileBaseState {
      pose { x y a timestamp }
      tag { qrId timestamp }
    }
    piggybackState {
      lift turntable slide hookLeft hookRight timestamp
    }
  }
}

# Single robot by name
query {
  robot(name: "SIMBOT") {
    name
    connectionStatus
  }
}

# All jobs
query { jobs { uuid status operation targetNode { alias } } }

# All requests (pickup+delivery pairs)
query { requests { uuid status pickup { targetNode { alias } } delivery { targetNode { alias } } } }
```

### Mutations

> **Note:** Mutations are stubbed in simulation mode (return "Not implemented in simulation mode").
> They require a real ROS action server to execute.

```graphql
# Move robot to a waypoint
mutation {
  sendTravelOrder(travelOrder: { robotName: "SIMBOT", targetNodeAlias: "Q10" }) {
    success message job { uuid status }
  }
}

# Pickup from a shelf cell
mutation {
  sendPickupOrder(pickupOrder: { robotName: "SIMBOT", targetNodeAlias: "S3C1L1" }) {
    success message job { uuid status }
  }
}

# Delivery to a shelf cell
mutation {
  sendDeliveryOrder(deliveryOrder: { robotName: "SIMBOT", cellLevel: 0, targetNodeAlias: "S3C3L2" }) {
    success message job { uuid status }
  }
}

# Pickup + Delivery as a paired request
mutation {
  sendRequestOrder(requestOrder: {
    robotName: "SIMBOT"
    requestAlias: { pickupNodeAlias: "S3C2L1", deliveryNodeAlias: "S3C3L2" }
  }) { success message request { uuid status } }
}

# Cancel current job
mutation { cancelCurrentJob(robotName: "SIMBOT") { uuid status } }
```

### Subscriptions (real-time push via WebSocket)

```graphql
subscription { robots { name connectionStatus lastActionStatus } }
subscription { robot(name: "SIMBOT") { connectionStatus mobileBaseState { pose { x y } } } }
```

### Graph Node Naming Convention

| Pattern | Meaning | Example |
|---|---|---|
| `Q{n}` | Waypoint | `Q1`, `Q119` |
| `S{n}` | Shelf | `S1`, `S3` |
| `S{s}C{c}L{l}` | Shelf cell (shelf, column, level) | `S3C2L1` |
| `__depot__` | Depot/home position | — |

---

## Warehouse Graph Schema

The DB stores a directed weighted graph used for A* pathfinding.

### Key Functions

```sql
-- Shortest path between two nodes (returns ordered list of node IDs)
SELECT * FROM wh_astar_shortest_path(1, 'Q1', 'Q10');

-- Cost matrix between multiple nodes
SELECT * FROM wh_astar_cost_matrix(1, ARRAY['Q1','Q5','Q10']);
```

### Key Views

```sql
SELECT * FROM wh_nodes_view;       -- All nodes with coordinates
SELECT * FROM wh_edges_view;       -- All edges with costs
SELECT * FROM wh_graph_summary_view; -- Graph statistics
```

### Regenerating `graph.sql`

`graph.sql` is a compiled master file. After editing individual files in `graph/`, rebuild it:

```bash
./db_schema/init_graph.bash
```

---

## Resetting the Database

If the DB volume has stale data or a password mismatch:

```bash
# WARNING: destroys all DB data
docker compose down -v
docker compose up -d

# Wait for DB to be healthy, then reload graph
docker exec -i wcs-db-1 psql -U postgres < db_schema/graph_layout/sample_fibo_6fl.sql
```

---

## Troubleshooting

### Robot shows OFFLINE

1. Check `robot_bridge` logs: `docker logs wcs-robot_bridge-1 -f`
2. Check `robot_simulator` is running: `docker ps`
3. Verify Redis has heartbeat: `docker exec wcs-redis-1 redis-cli get robot:SIMBOT:heartbeat`

### Fleet Gateway fails to start

```bash
docker logs wcs-fleet_gateway-1
```

Common causes:
- Redis not ready yet (wait ~10s, it auto-retries)
- Build error in `fleet_gateway_custom/` — run `docker compose build fleet_gateway`

### `vrp_server` unhealthy

Usually a DB password mismatch. Reset the volume (see above).

### pgRouting errors (`_pgr_get_statement does not exist`)

Already fixed via `PGRST_DB_EXTRA_SEARCH_PATH: extensions` in `docker-compose.yml` and `SET search_path = public, extensions` in `db_schema/graph/functions.sql`. If you see this after a fresh DB init, reload the schema:

```bash
docker exec -i wcs-db-1 psql -U postgres < db_schema/graph.sql
```

---

## Known Limitations

- **Mutations are stubbed** in the current fleet_gateway_custom — they return "Not implemented in simulation mode". Real execution requires a ROS action server (FIBO robot hardware).
- **VRP multi-robot routing** (`sendWarehouseOrder`) requires `vrp_server` to be healthy.
- **Subscriptions** work via Redis pub/sub but require a WebSocket client (not plain HTTP).
