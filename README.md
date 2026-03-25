# WCS — Warehouse Control System

A full-stack distributed system for managing autonomous mobile robot (AMR) fleets in a warehouse environment. WCS provides an end-to-end workflow from warehouse graph design through route optimization to live fleet monitoring — all within a single browser-based interface.

The operator uses the **Map Designer** to draw the warehouse topology (nodes, edges, multi-level shelves) on a drag-and-drop canvas. They then switch to the **Optimization** tab to queue pickup-delivery tasks and run a VRP solver (C++ OR-Tools) to compute optimal multi-robot routes. Computed routes are dispatched to physical robots via the **Fleet Gateway**, which bridges the WCS backend to ROS 2 robots over rosbridge WebSocket. The **Fleet Controller** tab provides real-time telemetry, a live system log, and a Hard Reset recovery sequence. A built-in **GQL Tester** gives operators direct GraphQL console access to the gateway without leaving the UI.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Tech Stack](#tech-stack)
3. [Repository Structure](#repository-structure)
4. [Feature Reference by UI Tab](#feature-reference-by-ui-tab)
5. [Installation & Quick Start](#installation--quick-start)
6. [Service URL Reference](#service-url-reference)
7. [Environment Variables](#environment-variables)
8. [Database Schema](#database-schema)
9. [GraphQL API Reference](#graphql-api-reference)
10. [Known Issues & Operational Notes](#known-issues--operational-notes)

---

## System Architecture

```
┌──────────────────────────────────────────────────────────┐
│               React Frontend  (Vite · :5173)              │
│                                                           │
│  ┌───────────┐ ┌──────────────┐ ┌───────────┐ ┌───────┐  │
│  │Map Designer│ │ Optimization │ │  Fleet    │ │  GQL  │  │
│  │(GraphEditor│ │  (VRP Tasks) │ │Controller │ │Tester │  │
│  │ + Nodes)  │ │              │ │           │ │       │  │
│  └─────┬─────┘ └──────┬───────┘ └─────┬─────┘ └───┬───┘  │
│        │  Supabase JS  │   /api/fleet  │           │      │
└────────┼───────────────┼──────────────┼───────────┼──────┘
         │               │    GraphQL   │           │
         ▼               │   HTTP POST  │           │
  ┌─────────────┐        ▼              ▼           │
  │   Supabase  │  ┌─────────────────────────────┐  │
  │   (Kong     │  │  Fleet Gateway  :8080        │  │
  │   :8000)    │  │  Python · FastAPI · Strawberry│  │
  │             │  │                             │  │
  │  PostgREST  │  │  route_oracle.py  (A* RPC)  │  │
  │  Storage    │◄─┤  vrp_client.py   (VRP RPC)  │  │
  │  Studio     │  │  Redis pub/sub              │  │
  │  Postgres   │  └──────┬──────────────┬────────┘  │
  │  :5432      │         │              │            │
  └─────────────┘         │         ┌───▼──────────┐ │
                          │         │ VRP Server   │ │
                    Redis │         │ :18080       │ │
                    :6379 │         │ C++ OR-Tools │ │
                          │         └──────────────┘ │
                          ▼                           │
                  ┌───────────────┐                   │
                  │ robot_bridge  │◄──────────────────┘
                  │  (Python)     │
                  └──────┬────────┘
                         │  Redis pub/sub (commands)
                         │  MQTT telemetry (state)
                         ▼
                  ┌───────────────┐
                  │  AMR Robot    │
                  │  ROS 2 +      │
                  │  rosbridge    │
                  │  :9090        │
                  └───────────────┘
```

### Data Flow Summary

| Direction | Transport | Description |
|---|---|---|
| Frontend → Supabase | HTTPS (Supabase JS) | Node/edge read-write, map image storage |
| Frontend → Fleet Gateway | HTTP POST (GraphQL) | Robot commands, telemetry polling |
| Fleet Gateway → Redis | Pub/Sub | Publishes motion commands to robot_bridge |
| robot_bridge → Redis | Key-Value | Writes heartbeat + state for gateway to read |
| robot_bridge → Robot | WebSocket (rosbridge) | Forwards ROS 2 action commands |
| Robot → robot_bridge | WebSocket (rosbridge) | Streams pose, QR tag, joint state |

---

## Tech Stack

### Frontend

| Technology | Version | Role |
|---|---|---|
| React | 19 | UI framework |
| TypeScript | 5.9 | Type safety |
| Vite (rolldown) | 7 | Build tool & dev server with reverse proxy |
| React Flow | 11 | Interactive graph canvas (Map Designer, Fleet map) |
| Tailwind CSS | 4 | Utility-first styling with dark mode |
| Zustand | 5 | Global state (theme persistence) |
| Supabase JS | 2 | Database client (nodes, edges, graphs, storage) |
| React Router | 7 | Client-side routing |
| MQTT.js | 5 | Direct broker subscription for robot telemetry |
| Lucide React | 0.562 | Icon library |
| Vitest | 4 | Unit testing |

### Backend

| Technology | Version | Role |
|---|---|---|
| Python | 3.12 | Fleet Gateway & robot_bridge runtime |
| FastAPI | ≥ 0.115 | HTTP server for Fleet Gateway |
| Strawberry GraphQL | ≥ 0.270 | GraphQL schema and resolvers |
| Redis | 7 (Alpine) | Pub/sub command bus + robot state cache |
| Supabase (self-hosted) | 2026.02 | Postgres, PostgREST, Storage, Studio, Kong |
| PostgreSQL | 15.8 | Primary database |
| pgRouting | — | A* pathfinding inside the DB |
| C++ OR-Tools VRP Server | — | Multi-vehicle route optimization |
| ROS 2 | — | Robot operating system (on physical AMR) |
| roslibpy / rosbridge | — | WebSocket bridge from Python to ROS 2 |
| Docker Compose | v2 | Orchestrates all backend services |

---

## Repository Structure

```
wcs/
├── .env                         # Active secrets (never commit — see .env.example)
├── .env.example                 # Template with all required variables
├── docker-compose.yml           # Entire backend stack definition
├── env_init.sh                  # First-run helper: generates JWT keys, writes .env
│
├── db_schema/
│   ├── graph.sql                # Master SQL — sources all files under graph/
│   ├── graph/
│   │   ├── tables.sql           # wh_graphs, wh_nodes, wh_edges, wh_levels, wh_cells, ...
│   │   ├── views.sql            # wh_nodes_view, wh_nodes_detailed_view, summary views
│   │   ├── functions.sql        # wh_astar_shortest_path, wh_astar_cost_matrix, ...
│   │   ├── indexes.sql          # Performance indexes on graph_id, node coords
│   │   ├── permissions.sql      # PostgREST role grants (anon, service_role)
│   │   ├── triggers.sql         # Auto-create depot node on new graph
│   │   ├── types.sql            # Custom enum types
│   │   └── yaml_conversion/     # Helper scripts to import RMF YAML maps → SQL
│   └── graph_layout/
│       ├── sample_fibo_6fl.sql  # Real 6-floor warehouse layout (133 waypoints)
│       └── sample_dummy.sql     # Minimal test graph
│
├── fleet_gateway_custom/        # Custom Fleet Gateway (replaces broken Docker Hub image)
│   ├── Dockerfile
│   ├── requirements.txt         # fastapi, strawberry-graphql, redis, httpx
│   ├── main.py                  # FastAPI app + Strawberry GraphQL schema
│   │                            #   Mutations: sendRequestOrder, sendRobotCommand,
│   │                            #             executePathOrder, cancelCurrentJob, ...
│   │                            #   Queries:   robots, jobs, requests
│   ├── route_oracle.py          # Calls PostgREST RPC for A* path expansion
│   └── vrp_client.py            # HTTP client to VRP Server (:18080)
│
├── robot_bridge/                # ROS 2 ↔ Redis bridge (one instance per physical robot)
│   ├── Dockerfile
│   ├── requirements.txt
│   └── main.py                  # Subscribes to ROS topics, writes to Redis;
│                                #   subscribes to Redis for commands, publishes to ROS
│
├── robot_simulator/             # Containerized ROS 2 simulator (dev/CI without hardware)
│   ├── Dockerfile
│   ├── pose_publisher.py
│   └── sim.launch.py
│
├── supabase/
│   └── config.toml              # Supabase local stack configuration
│
├── volumes/
│   ├── api/kong.yml             # Kong declarative config (routes, plugins, auth)
│   └── db/                      # PostgreSQL init SQL (roles, JWT, extensions)
│
└── frontend/                    # React / Vite SPA
    ├── index.html
    ├── vite.config.ts           # Dev-server proxy routes (see table below)
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── main.tsx             # React root, BrowserRouter
        ├── App.tsx              # Routes: / → Dashboard, /:graphId → FleetInterface
        │
        ├── components/
        │   ├── FleetInterface.tsx      # Root shell: header, tab switcher, robot selector,
        │   │                           #   shared useFleetGateway hook, sim-mode toggle
        │   ├── GraphEditor.tsx         # Tab 1 — Map Designer (React Flow canvas)
        │   ├── Optimization.tsx        # Tab 2 — VRP task queue + dispatch
        │   ├── FleetController.tsx     # Tab 3 — Live fleet map + telemetry table + logs
        │   ├── GraphQLTester.tsx       # Tab 4 — In-browser GraphQL IDE
        │   ├── RouteVisualizer.tsx     # Shared modal/inline map for route preview
        │   ├── Dashboard.tsx           # Landing page — warehouse graph index
        │   ├── ThemeToggle.tsx         # Dark / light mode button
        │   ├── GlobalErrorBoundary.tsx # React error boundary (catches render errors)
        │   └── nodes/
        │       └── WaypointNode.tsx    # Custom React Flow node: waypoint/shelf/cell/depot
        │                               #   persistent label, hover tooltip, handles
        │
        ├── hooks/
        │   ├── useFleetGateway.ts     # Polls /api/fleet/graphql for robot states;
        │   │                          #   exposes dispatchRequest, hardReset, activeRobotName
        │   ├── useGraphData.ts        # Supabase CRUD: nodes, edges, levels, cells;
        │   │                          #   saveGraph, loadGraph, createCell, deleteLevel
        │   ├── useFleetSocket.ts      # MQTT subscription for real-time robot telemetry;
        │   │                          #   provides robotStates, logs, publishCommand
        │   ├── useMQTT.ts             # Low-level MQTT.js hook (connect/subscribe/publish)
        │   ├── useRobotSimulation.ts  # Simulated robot path-stepping (no hardware needed)
        │   └── useTasks.ts            # Task queue helpers
        │
        ├── utils/
        │   ├── fleetGateway.ts        # GraphQL client for Fleet Gateway:
        │   │                          #   executePathOrder, sendRobotControlCommand,
        │   │                          #   dispatchVehicleRoute, cancelAllDispatches,
        │   │                          #   VEHICLE_ROBOT_MAP, setVehicleRobot
        │   ├── solverUtils.ts         # Local A* pathfinding + distance matrix generation
        │   ├── solverUtils.test.ts    # Vitest unit tests for solver utilities
        │   └── vrpApi.ts              # Dual-server VRP client (Python fallback → C++ primary)
        │
        ├── store/
        │   └── themeStore.ts          # Zustand store — persists 'dark'|'light' in localStorage
        │
        ├── lib/
        │   └── supabaseClient.ts      # Supabase JS client (reads VITE_SUPABASE_* env vars)
        │
        └── types/
            └── database.ts            # TypeScript interfaces mirroring the DB schema:
                                       #   DBNode, DBEdge, DBGraph, DBLevel, DBCell,
                                       #   DBRobot, DBRequest, DBAssignment, DBTask
```

### Vite Dev-Server Proxy Routes

| Prefix | Target | Purpose |
|---|---|---|
| `/api/fleet` | `http://127.0.0.1:8080` | Fleet Gateway GraphQL (local Docker) |
| `/api/robot-gw` | `http://10.61.6.87:8080` | Direct robot gateway (on-network AMR) |
| `/api/vrp` | `http://127.0.0.1:7779` | Python VRP fallback server |
| `/api/cpp-vrp` | `http://127.0.0.1:18080` | C++ OR-Tools VRP server |

---

## Feature Reference by UI Tab

### Tab 1 — Map Designer (`GraphEditor`)

The Map Designer is a full-featured warehouse topology editor built on React Flow.

- **Node types**: Waypoint, Conveyor, Shelf, Cell, Depot — each rendered with a distinct color, icon, and persistent alias label below the node body.
- **Edge creation**: Switch to **Connect mode** (link icon) to draw directed edges between nodes. Pan-on-drag is automatically disabled in connect mode to prevent accidental canvas movement during edge creation.
- **Background map**: Upload a PNG/JPG floorplan to Supabase Storage. Lock/unlock the background image independently from the node layer. Remove the background without losing graph data.
- **Multi-level shelf management**: Select a shelf node to open the **Shelf Panel**. Create height levels (`L1`, `L2`, …) and add cells per level. Cell aliases are auto-generated in the canonical format `S{shelf}C{column}L{level}` (e.g. `S3C2L3`) — a preview of the generated alias is shown before creation. Delete levels and cells with confirmation dialogs.
- **Level filter**: Filter the canvas to display only nodes belonging to a selected level, reducing visual clutter in dense multi-floor layouts.
- **Save**: The **Save Complete Graph Configuration** button persists all node positions, properties, and edges to Supabase in a single batch. Toast notifications confirm success or display error details.
- **Error handling**: All database operations (upload, save, create level, delete cell, etc.) are wrapped in try-catch with descriptive toast notifications.

### Tab 2 — Optimization (`Optimization`)

The Optimization tab manages the full VRP (Vehicle Routing Problem) workflow.

- **Auto-load**: Map data is fetched automatically on tab mount — no manual button click is required. The right-panel map renders immediately.
- **Task queue**: Add pickup-delivery node pairs using enriched dropdowns (node alias + type + level alias). Click the map icon to select nodes directly from the interactive RouteVisualizer modal.
- **A* task preview**: Click the eye icon on any queued task to run local A* pathfinding and visualize the individual route in the RouteVisualizer overlay.
- **VRP optimization**: Click **Optimize Fleet Routes** to send the full task queue to the C++ OR-Tools VRP server (with Python server as fallback). Configurable vehicle count and per-vehicle capacity.
- **Route dispatch**: After a solution is computed, click **Dispatch** to iterate over the VRP-optimised task sequence and fire one `sendRequestOrder` mutation per task in visit order via the Redis pub/sub path.

  > **Important**: The `executePathOrder` mutation is intentionally bypassed. It writes to the database but does not publish to Redis, so the robot never receives the command. `sendRequestOrder` is the proven dispatch path.

- **Per-task results**: Each dispatched task displays a live result (`✓ UUID…` or `✗ error message`) as commands are acknowledged by the gateway.
- **Direct GQL Dispatch**: Fire individual tasks to a selected robot independently of the VRP solver. Includes robot readiness warnings (OFFLINE / ERROR / OPERATING states).
- **Simulation mode**: When the SIM toggle is active in the header, dispatch calls are logged to the browser console but no network requests are sent.

### Tab 3 — Fleet Controller (`FleetController`)

Real-time fleet visualization and robot management.

- **Live map**: Robots are rendered as animated markers on the warehouse React Flow canvas. Busy robots display a pulsing ring animation. Robot position is updated from MQTT telemetry streamed via the robot_bridge.
- **Fleet table**: One row per robot showing MQTT status (idle/busy/offline/error), GQL overlay status (ONLINE/OFFLINE · IDLE/OPERATING/ERROR), battery percentage, current task, and active path sequence (node alias chain).
- **Active robot highlight**: The globally selected robot (from the header robot selector dropdown) is highlighted with a blue left-bar indicator and blue-tinted background across both the table and the map canvas.
- **Robot controls**: Per-robot **PAUSE**, **RESUME**, **ESTOP**, and **Hard Reset** buttons. ESTOP broadcasts to all active robots and cancels all pending dispatches via a global abort controller.
- **Hard Reset sequence**: A 4-step automated recovery workflow:
  1. Cancel the current job (marks as CANCELED)
  2. Clear ERROR state via `clearRobotError` mutation
  3. Poll until `lastActionStatus` returns to IDLE
  4. Verify the robot is ONLINE in the gateway

  Step progress is shown inline per robot row with live color-coded status indicators.
- **Simulation routes**: When a VRP solution is dispatched, A*-expanded path overlays are rendered as colored lines on the fleet map canvas.
- **System Logs panel**: Real-time color-coded log stream. Entries are classified by content:
  - 🔴 **Red** — errors, ESTOP, failure keywords (`✗`, `fail`, `[ERROR]`)
  - 🟢 **Green** — success events, Hard Reset passed, IDLE confirmation (`✓`, `successfully`, `passed`)
  - 🟡 **Amber** — warnings, OPERATING state, offline events (`⚠`, `OPERATING`, `offline`)
  - 🔵 **Blue** — informational (default, all other log entries)

### Tab 4 — GQL Tester (`GraphQLTester`)

A built-in GraphQL query console backed by the Fleet Gateway.

- Executes any query or mutation against `http://localhost:8080/graphql` via the `/api/fleet` proxy — no external tooling required.
- Pre-populated with common operations: robot status, `sendRequestOrder`, `cancelCurrentJob`, `clearRobotError`.
- Robot selector syncs with the globally active robot from the header.
- Responses displayed as formatted JSON with error highlighting.
- Useful for verifying gateway connectivity, debugging robot state, and testing new mutations during development.

---

## Installation & Quick Start

### Prerequisites

- Docker Desktop ≥ 24 with Compose v2
- Node.js ≥ 20 with npm ≥ 10
- A physical ROS 2 AMR with rosbridge running **or** use the included `robot_simulator` container

---

### Step 1 — Backend Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd wcs

# 2. Generate JWT keys and populate .env from the template
chmod +x env_init.sh
./env_init.sh

# 3. Configure your robot fleet
#    Edit ROBOTS_CONFIG in .env to match your robot's IP and cell heights:
#    ROBOTS_CONFIG='{"MYROBOT": {"host": "192.168.1.100", "port": 9090, "cell_heights": [0.65, 1.07, 1.49, 1.91]}}'
nano .env

# 4. Start all backend services
docker compose up -d

# 5. Verify all services are running
docker compose ps
```

> **Database initialization**: `db_schema/graph.sql` is mounted as a Docker init script and runs automatically on the first container startup. It creates all tables, views, functions, indexes, and permissions. No manual SQL execution is needed for the schema.

```bash
# 6. Load the warehouse graph layout (required — schema does not include node data)

# Option A: 6-floor real warehouse layout (133 waypoints, graph_id = 1)
docker exec -i wcs-db-1 psql -U postgres < db_schema/graph_layout/sample_fibo_6fl.sql

# Option B: Minimal test graph
docker exec -i wcs-db-1 psql -U postgres < db_schema/graph_layout/sample_dummy.sql
```

---

### Step 2 — Frontend Setup

```bash
cd frontend

# 1. Install dependencies
npm install

# 2. Create the frontend environment file
#    Replace <your-anon-key> with the ANON_KEY printed by env_init.sh
cat > .env.local << 'EOF'
VITE_SUPABASE_URL=http://localhost:8000
VITE_SUPABASE_ANON_KEY=<your-anon-key>
EOF

# 3. Start the development server
npm run dev
```

Open **http://localhost:5173** in your browser.

---

### Step 3 — Optional: Robot Simulator

The repository includes a containerized ROS 2 simulator for development without physical hardware. It starts automatically with `docker compose up -d`.

```bash
# To use the simulator instead of a real robot, update .env:
ROBOTS_CONFIG='{"SIMBOT": {"host": "robot_simulator", "port": 9090, "cell_heights": [0.65, 1.07, 1.49, 1.91]}}'

# Restart only the fleet gateway to pick up the config change
docker compose up -d --force-recreate fleet_gateway
```

---

### Production Build

```bash
cd frontend
npm run build      # TypeScript compile + Vite bundle → frontend/dist/
npm run preview    # Serve the production build locally for smoke testing
```

---

### Running Tests

```bash
cd frontend
npm test           # Run Vitest unit tests (solverUtils, etc.)
```

---

## Service URL Reference

| Service | URL | Default Credentials |
|---|---|---|
| **WCS Frontend** | `http://localhost:5173` | — |
| **Fleet Gateway GraphQL** | `http://localhost:8080/graphql` | — |
| **Supabase Studio** | `http://localhost:54323` | `supabase` / `supabase` |
| **Supabase API (Kong)** | `http://localhost:8000` | `ANON_KEY` header |
| **PostgreSQL** | `localhost:5432` | `postgres` / `POSTGRES_PASSWORD` |
| **Redis** | `localhost:6379` | — |
| **VRP Server** | `http://localhost:18080` | — |
| **Robot Simulator (rosbridge)** | `ws://localhost:9090` | — |

---

## Environment Variables

### Backend — `wcs/.env`

| Variable | Example | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | `changeme-secret` | PostgreSQL superuser password. **Must match across all DB-connected services.** If changed after first run, destroy and recreate volumes. |
| `JWT_SECRET` | `<32+ char string>` | JWT signing secret for Supabase auth and PostgREST verification. |
| `ANON_KEY` | `<JWT>` | Supabase anonymous API key (read-only public access). Auto-generated by `env_init.sh`. |
| `SERVICE_ROLE_KEY` | `<JWT>` | Supabase service-role key (full DB access, bypasses RLS). Auto-generated. |
| `ROBOTS_CONFIG` | `'{"MYBOT": {"host": "10.0.0.5", "port": 9090, "cell_heights": [0.65, 1.07]}}'` | JSON map of robot name → rosbridge host/port + physical cell heights in meters. The robot name **must exactly match** the `ROBOT_NAME` variable used in `robot_bridge`. |
| `ROBOT_NAME` | `MYBOT` | Robot name for the `robot_bridge` container. Must match a key in `ROBOTS_CONFIG`. |
| `ROBOT_HOST` | `10.0.0.5` | rosbridge host for the physical robot. |
| `ROBOT_PORT` | `9090` | rosbridge WebSocket port. |
| `GRAPH_ID` | `1` | Default warehouse graph ID passed to the fleet gateway for path resolution. |
| `GRAPHQL_IDE` | `graphiql` | Embedded IDE served at the gateway URL. Options: `graphiql`, `apollo-sandbox`, `graphql-playground`. |
| `STUDIO_PORT` | `54323` | Port for the Supabase Studio web UI. |
| `DASHBOARD_USERNAME` | `supabase` | Supabase Studio login username. |
| `DASHBOARD_PASSWORD` | `supabase` | Supabase Studio login password. |

> **Critical alignment**: `ROBOTS_CONFIG` robot name, `ROBOT_NAME` in robot_bridge, and the `robotName` argument in all GraphQL mutations must be identical strings (case-sensitive). A mismatch causes the gateway to find no Redis heartbeat and report the robot as permanently `OFFLINE`.

---

### Frontend — `frontend/.env.local`

| Variable | Example | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | `http://localhost:8000` | Supabase API base URL (goes through Kong). In production, replace with your hosted Supabase project URL. |
| `VITE_SUPABASE_ANON_KEY` | `<JWT>` | Anon key for the Supabase JS client. Must match `ANON_KEY` in the backend `.env`. |

> `VITE_*` variables are embedded into the JavaScript bundle at compile time and are visible in the browser. Do not store secrets in frontend environment variables.

---

## Database Schema

All schema files live in `db_schema/graph/` and are applied automatically via `db_schema/graph.sql` on first container startup.

### Core Tables

| Table | Description |
|---|---|
| `wh_graphs` | Warehouse layout registry (id, name, map_url) |
| `wh_nodes` | Physical points on the warehouse floor: coordinates (x, y), alias, type, orientation angle |
| `wh_edges` | Traversable connections between nodes (bidirectional in practice) |
| `wh_levels` | Named height levels for multi-floor shelf management (L1 = 0.65 m, etc.) |
| `wh_cells` | Storage cells at a specific node + level (linked to physical shelf columns) |
| `wh_robots` | Robot fleet registry (name, status, endpoint, capacity) |
| `wh_requests` | Pickup-delivery requests from the WMS or operator |
| `wh_assignments` | VRP-computed or manually created robot assignments |
| `wh_tasks` | Individual pickup or delivery tasks within an assignment |

### Key Views

| View | Description |
|---|---|
| `wh_nodes_view` | Nodes joined with level and cell metadata — used by the frontend dropdowns |
| `wh_nodes_detailed_view` | Nodes with full `level_alias` and physical height fields |
| `wh_graph_summary_view` | Per-graph statistics: node count, edge count, level count |

### pgRouting Functions

| Function | Description |
|---|---|
| `wh_astar_shortest_path(graph_id, start_id, end_id)` | Returns ordered node IDs along the shortest A* path between two nodes |
| `wh_astar_cost_matrix(graph_id, node_ids[])` | Returns the pairwise travel cost matrix for VRP distance computation |

> **pgRouting search_path requirement**: PostgREST must include `extensions` in its `search_path` for pgRouting's internal functions to resolve. This is configured via `PGRST_DB_EXTRA_SEARCH_PATH: extensions` in `docker-compose.yml` and `SET search_path = public, extensions` in each function definition in `functions.sql`.

### Node Naming Convention

| Type | Format | Example |
|---|---|---|
| Waypoint | `Q{n}` | `Q1`, `Q119` |
| Shelf | `S{n}` | `S1`, `S3` |
| Cell | `S{shelf}C{column}L{level}` | `S3C2L1` (shelf 3, column 2, level 1) |
| Depot | `__depot__` | `__depot__` |
| Conveyor | `C{n}` | `C1` |

---

## GraphQL API Reference

**Endpoint**: `http://localhost:8080/graphql`
**Interactive IDE**: same URL (GraphiQL by default — configurable via `GRAPHQL_IDE`)

### Robot Commands

```graphql
# Queue a pickup + delivery task
# This is the proven Redis dispatch path — always use this for robot motion
mutation {
  sendRequestOrder(requestOrder: {
    robotName: "MYROBOT"
    requestAlias: { pickupNodeAlias: "S3C2L1", deliveryNodeAlias: "S5C1L2" }
  }) {
    success
    message
    request { uuid status pickup { alias } delivery { alias } }
  }
}

# Send a travel-only command to a waypoint
mutation {
  sendTravelOrder(travelOrder: {
    robotName: "MYROBOT"
    targetNodeAlias: "Q119"
  }) {
    success message job { uuid status }
  }
}

# Control commands: PAUSE | RESUME | ESTOP | CANCEL | CANCEL_ALL
mutation {
  sendRobotCommand(robotName: "MYROBOT", command: "ESTOP") {
    success message
  }
}

# Cancel the currently active job
mutation {
  cancelCurrentJob(robotName: "MYROBOT") { uuid status }
}

# Clear ERROR state (required before any new dispatch after a fault)
mutation {
  clearRobotError(robotName: "MYROBOT")
}
```

### Robot Status Query

```graphql
query {
  robots {
    name
    connectionStatus    # ONLINE | OFFLINE
    lastActionStatus    # IDLE | OPERATING | CANCELED | ERROR
    mobileBaseState {
      tag  { qrId timestamp }
      pose { x y a timestamp }
    }
    piggybackState {
      lift turntable slide hookLeft hookRight timestamp
    }
    cells {
      height
      holding { uuid status }
    }
    currentJob { uuid status operation targetNode { alias } }
    jobQueue   { uuid status operation targetNode { alias } }
  }
}
```

---

## Known Issues & Operational Notes

### Volume Password Mismatch

If `docker compose` was run after changing `POSTGRES_PASSWORD` without destroying volumes, all TCP-connected services (`vrp_server`, `rest`, `storage`) will fail with `password authentication failed`.

**Resolution** — destroys all database data:
```bash
docker compose down -v
docker compose up -d
docker exec -i wcs-db-1 psql -U postgres < db_schema/graph_layout/sample_fibo_6fl.sql
```

---

### `executePathOrder` Does Not Trigger Robot Motion

The `executePathOrder` GraphQL mutation writes the route to the database but **does not publish to the Redis pub/sub channel** that the robot's motion controller subscribes to. The mutation returns `success: true` but the robot never moves.

**Always use `sendRequestOrder`** (or `sendTravelOrder`) for actual robot dispatch. The Optimization tab's Dispatch button follows this pattern automatically and the workaround is documented inline in the source code.

---

### Robot Name Must Be Consistent Across Three Places

The robot name string must match exactly (case-sensitive) in all three of:

1. The key in `ROBOTS_CONFIG` in `wcs/.env`
2. The `ROBOT_NAME` environment variable for the `robot_bridge` container
3. The `robotName` argument in every GraphQL mutation

A mismatch causes the gateway to find no Redis heartbeat key and permanently report the robot as `OFFLINE`.

---

### pgRouting Functions After Volume Reset

After destroying and recreating volumes, the `SET search_path = public, extensions` clause must be present in all pgRouting wrapper functions. It is included in `db_schema/graph/functions.sql` and applied automatically on first startup. If you applied it manually as a live fix in a previous session, it will not persist after a volume reset.

Verify with:
```sql
SELECT pg_get_functiondef('wh_astar_shortest_path'::regproc);
```

---

### Simulation Mode

Toggle the **SIM** button in the header to enable simulation mode globally. In this mode:
- All `sendRequestOrder` dispatch calls are logged to the browser console but **no HTTP requests** are made to the Fleet Gateway.
- The VRP solver still runs and routes are visualized normally.
- Useful for UI testing, demonstrating route optimization, and verifying task queue logic without a connected robot.

---

### VRP Server Health

The `vrp_server` container (`journeykmutt/vrp_server`) requires a healthy database connection. If it appears `unhealthy` in `docker compose ps`, it is typically caused by a volume password mismatch (see above). The frontend falls back to the Python VRP server (`/api/vrp` → `:7779`) if the C++ server is unavailable.

---

## License

Internal project — Lertvilai V2 / WCS Team. All rights reserved.
