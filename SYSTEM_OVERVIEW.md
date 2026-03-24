# WCS — Warehouse Control System: System Overview

> Written for a new Claude instance with zero prior context.
> This document covers architecture, current stack state, bugs fixed, and what to test next.

---

## What This System Does

A distributed system that controls an autonomous mobile robot (AMR) fleet in a warehouse. It handles:
- Sending travel/pickup/delivery orders to robots
- Real-time robot position and state tracking
- Route optimization using pgRouting A* on a warehouse graph
- VRP (Vehicle Routing Problem) solving for multi-robot multi-order scenarios

The robot communicates over ROS2, bridged via WebSocket (rosbridge). The backend exposes a GraphQL API.

---

## Repository Layout

```
Test_Docker/
├── wcs/                    # Docker Compose stack + DB schema
│   ├── docker-compose.yml
│   ├── .env
│   └── db_schema/
│       ├── graph/          # SQL: tables, functions, views, indexes, permissions
│       ├── graph_layout/
│       │   ├── sample_fibo_6fl.sql   # Real warehouse layout (currently loaded)
│       │   └── sample_dummy.sql
│       └── graph.sql       # Master SQL that runs all graph/ files
└── fleet_gateway/          # Python FastAPI + GraphQL service (cloned from FIBO-Engineer/fleet_gateway)
    ├── Dockerfile
    ├── main.py
    ├── requirements.txt
    └── fleet_gateway/
        ├── robot.py            # ROS bridge connector + job dispatcher
        ├── fleet_handler.py    # Manages dict of RobotHandler objects
        ├── warehouse_controller.py  # Business logic: accept/cancel orders
        ├── order_store.py      # Redis persistence for jobs/requests
        ├── route_oracle.py     # Supabase RPC calls for pathfinding
        ├── enums.py
        ├── models.py
        └── api/
            ├── schema.py       # Strawberry GraphQL schema
            ├── types.py        # GraphQL types
            ├── type_resolvers.py
            └── ...
```

---

## Architecture

```
Client (browser / curl)
        |
   GraphQL  ws://localhost:8080/graphql
        |
  Fleet Gateway  :8080  (Python · FastAPI · Strawberry)
   |          |
Redis      Kong :8000  (Supabase API gateway)
:6379        |
          PostgREST → PostgreSQL :5432
                      (supabase/postgres + pgRouting)
                            |
                      VRP Server :18080  (C++ · OR-Tools)

Fleet Gateway → Robot (roslibpy WebSocket → rosbridge :9090)
```

---

## Service Map

| Service | Image | Port | Status |
|---|---|---|---|
| `db` | supabase/postgres:15.8.1.085 | 5432 | healthy |
| `rest` (PostgREST) | postgrest/postgrest:v14.5 | — (via Kong) | running |
| `meta` | supabase/postgres-meta:v0.95.2 | — | running |
| `storage` | supabase/storage-api:v1.37.8 | — | restarting (auth issue) |
| `studio` | supabase/studio:2026.02.16 | 54323 | healthy |
| `kong` | kong:2.8.1 | 8000 / 8443 | healthy |
| `redis` | redis:7-alpine | 6379 | healthy |
| `vrp_server` | journeykmutt/vrp_server:latest | 18080 | **unhealthy** — DB auth fails |
| `fleet_gateway` | **built locally** from `../fleet_gateway` | 8080 | running |

> `vrp_server` and `storage` are unhealthy because the `db_data` Docker volume contains
> old data initialized with a different password than what is currently in `.env`.
> **This has not been fixed yet.** The fix is: `docker compose down -v && docker compose up -d`
> (destroys all DB data — load graph SQL again afterwards).

---

## Robot Configuration

Configured in `.env`:

```
ROBOTS_CONFIG='{"FACOBOT": {"host": "10.61.6.87", "port": 9090, "cell_heights": [0.653, 1.073, 1.493, 1.913]}}'
```

- Robot name: `FACOBOT`
- Rosbridge at: `10.61.6.87:9090`
- 4 cell levels: 0.653m, 1.073m, 1.493m, 1.913m

---

## GraphQL API — Quick Reference

**Endpoint:** `http://localhost:8080/graphql`
**IDE:** same URL (GraphiQL)

### Queries
```graphql
query {
  robots {
    name
    connectionStatus       # ONLINE | OFFLINE
    lastActionStatus       # IDLE | OPERATING | CANCELED | ERROR
    mobileBaseState {
      tag { qrId timestamp }
      pose { x y a timestamp }
    }
    piggybackState { lift turntable slide hookLeft hookRight timestamp }
    cells { height holding { uuid status } }
    currentJob { uuid status operation targetNode { alias } }
    jobQueue { uuid status operation targetNode { alias } }
  }
}

query { jobs { uuid status operation targetNode { alias } } }
query { requests { uuid status pickup { ... } delivery { ... } } }
```

### Mutations
```graphql
# Move robot to a waypoint
mutation { sendTravelOrder(travelOrder: { robotName: "FACOBOT", targetNodeAlias: "Q119" }) { success message job { uuid status } } }

# Pickup from a cell
mutation { sendPickupOrder(pickupOrder: { robotName: "FACOBOT", targetNodeAlias: "S3C1L1" }) { success message job { uuid status } } }

# Delivery to a cell
mutation { sendDeliveryOrder(deliveryOrder: { robotName: "FACOBOT", cellLevel: 0, targetNodeAlias: "S3C3L2" }) { success message job { uuid status } } }

# Pickup + Delivery as a pair
mutation {
  sendRequestOrder(requestOrder: {
    robotName: "FACOBOT"
    requestAlias: { pickupNodeAlias: "S3C2L1", deliveryNodeAlias: "S3C3L2" }
  }) { success message request { uuid status pickup { ... } delivery { ... } } }
}

# Cancel
mutation { cancelCurrentJob(robotName: "FACOBOT") { uuid status } }
mutation { cancelJobs(uuids: ["..."]) { uuid status } }

# After ERROR status
mutation { clearRobotError(robotName: "FACOBOT") }
```

### Graph node naming convention
- Waypoints: `Q1`, `Q2`, ... `Q133`, `Q119`, etc.
- Shelves: `S1`, `S2`, `S3`, ...
- Cells: `S{shelf}C{column}L{level}` — e.g. `S3C2L1` = shelf 3, column 2, level 1
- Depot: `__depot__`

---

## DB Schema Notes

- Graph loaded: `fibo_6fl` (graph_id = 1)
- pgRouting functions live in `extensions` schema, not `public`
- All PostgREST RPC calls need `extensions` in search_path (already fixed — see below)
- Main views: `wh_nodes_view`, `wh_edges_view`, `wh_graph_summary_view`
- Main functions: `wh_astar_shortest_path`, `wh_astar_cost_matrix`

---

## What Was Tested and Works

- `connectionStatus: ONLINE` — robot connects via rosbridge
- `mobileBaseState.tag` — live QR tag from `/qr_id` ROS topic
- `mobileBaseState.pose` — live position from `/odom_qr` ROS topic
- `piggybackState` — live joint state from `/piggyback_state` ROS topic
- `sendTravelOrder` — robot moves, `lastActionStatus` becomes OPERATING
- `sendPickupOrder` — dispatches to ROS action server
- `sendRequestOrder` — pickup + delivery queued in order
- `cancelCurrentJob` / `cancelJobs` — jobs cancel cleanly
- `clearRobotError` — resets ERROR state

---

## Known Issues / Not Yet Tested

- `vrp_server` is unhealthy (DB password mismatch) — `sendWarehouseOrder` (multi-robot VRP) is untested
- `storage` service is restarting (same DB password issue)
- `sendDeliveryOrder` with `cellLevel` parameter — not yet tested standalone
- Subscription (WebSocket real-time push) — not yet tested
- The web frontend at `http://localhost:8080` sends `query Pose($name: String!)` with `name: null` on load — frontend bug, not backend

---

---

# การแก้ไขทั้งหมดที่ทำในเซสชันนี้

## 1. สาเหตุที่ `vrp_server` ขึ้นไม่ได้ (วิเคราะห์ ไม่ได้แก้)

**ปัญหา:** `vrp_server` ต่อ PostgreSQL ไม่ได้ → `fleet_gateway` (ที่ depends_on vrp_server: healthy) ขึ้นไม่ได้

**สาเหตุ:** Docker volume `db_data` มีข้อมูลเก่าที่ถูก initialize ด้วย password คนละชุดกับ `.env` ปัจจุบัน ทำให้ทุก service ที่ต่อ DB ผ่าน TCP (vrp_server, rest, storage) ได้รับ `FATAL: password authentication failed`

**วิธีแก้ (ยังไม่ได้ทำ):**
```bash
docker compose down -v   # ลบ volumes ทิ้ง
docker compose up -d
# แล้ว load graph ใหม่
docker exec -i wcs-db-1 psql -U postgres < db_schema/graph_layout/sample_fibo_6fl.sql
```

---

## 2. เปลี่ยน `fleet_gateway` จาก Docker Hub image มาเป็น build จาก source

**ปัญหา:** Image `journeykmutt/fleet_gateway:latest` (build 13 Mar 2026) มี bug ทำให้หุ่น OFFLINE ตลอด

**การแก้ใน `wcs/docker-compose.yml`:**
```yaml
# เดิม
fleet_gateway:
  image: journeykmutt/fleet_gateway:latest

# แก้เป็น
fleet_gateway:
  build: ../fleet_gateway
```

**เหตุผล:** Source code repo ใหม่ (`FIBO-Engineer/fleet_gateway`) มีโค้ดที่ถูกต้องกว่า และ fix bugs ได้ตรงจุด

---

## 3. แก้ Bug `self.run(1.0)` — ทำให้หุ่น OFFLINE ตลอด

**ไฟล์:** `fleet_gateway/fleet_gateway/robot.py` line 41

**ปัญหา:** `RobotConnector.__init__` เรียก `self.run(1.0)` แต่ version ของ roslibpy ที่ compile ไว้ใน binary ไม่รับ argument → error `RobotHandler.run() takes 1 positional argument but 2 were given`

**การแก้:**
```python
# เดิม
self.run(1.0)

# แก้เป็น
Ros.run(self)
```

**เหตุผล:** `RobotHandler` override method `run()` ไว้ใช้เป็น job processor ทำให้ `self.run()` เรียกผิด method ต้องเรียก `Ros.run(self)` โดยตรง เพื่อให้แน่ใจว่าเป็น WebSocket event loop ของ roslibpy ไม่ใช่ job dispatcher

---

## 4. แก้ Bug State Initialization — `AttributeError: 'RobotHandler' has no attribute 'name'`

**ไฟล์:** `fleet_gateway/fleet_gateway/robot.py`

**ปัญหา:** `self.name` และ state อื่นๆ ถูก set ไว้ *หลัง* `self.run()` พอ `Ros.run()` connect สำเร็จและยิง callback ก็หา `self.name` ไม่เจอ

**การแก้:** ย้าย state initialization ขึ้นมาก่อน `Ros.run(self)`:

```python
# ลำดับใหม่ใน __init__:
self.factory.maxDelay = 5

# ต้อง set state ก่อน run()
self.name = name
self.active_status = True
self.autorun = True
self.last_action_status = RobotActionStatus.IDLE
self.mobile_base_state = MobileBaseState(None, None)
self.piggyback_state = None

try:
    Ros.run(self)   # connect หลังจาก state พร้อมแล้ว
    ...
```

---

## 5. แก้ Bug pgRouting ผ่าน PostgREST — `function _pgr_get_statement does not exist`

**ปัญหา:** เรียก `wh_astar_shortest_path` ผ่าน REST API แล้ว error เพราะ PostgREST ตั้ง `search_path` ไว้แค่ `public` แต่ pgRouting internal functions อยู่ใน `extensions` schema

**การแก้ใน `wcs/docker-compose.yml`:**
```yaml
rest:
  environment:
    PGRST_DB_EXTRA_SEARCH_PATH: extensions   # เพิ่มบรรทัดนี้
```

**และ ALTER FUNCTION ใน DB (live fix — จะหายถ้า reset volume):**
```sql
ALTER FUNCTION public.wh_astar_shortest_path(...) SET search_path = public, extensions;
ALTER FUNCTION public.wh_astar_cost_matrix(...) SET search_path = public, extensions;
ALTER FUNCTION public.wh_build_pgrouting_edges_query_3d(...) SET search_path = public, extensions;
```

> ควรเพิ่ม `SET search_path = public, extensions` ใน `db_schema/graph/functions.sql` ให้ถาวร

---

## 6. แก้ Bug Cancel Job ไม่ Clear `current_job`

**ไฟล์:** `fleet_gateway/fleet_gateway/robot.py` — method `cancel_current_job()`

**ปัญหา:** Job ที่อยู่ใน QUEUING (ยังไม่ถูกส่งไป ROS action) มี `action_future = None` พอ cancel แล้ว method แค่ log warning แต่ไม่ clear `self.current_job` ทำให้หุ่น stuck ส่ง order ใหม่ไม่ได้

**การแก้:**
```python
def cancel_current_job(self):
    if self.action_future is not None:
        self.warehouse_cmd_action_client.cancel_goal(self.action_future)
    else:
        # เพิ่มส่วนนี้: job ยังไม่ถูกส่งไป ROS ให้ clear ทันที
        if self.current_job is not None:
            self.current_job.status = OrderStatus.CANCELED
            self.loop.call_soon_threadsafe(self.job_updater.put_nowait, self.current_job)
            self.current_job = None
            self.trigger()
```
