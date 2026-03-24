"""
Custom Fleet Gateway
====================
Replacement for the broken journeykmutt/fleet_gateway binary.

Reads robot state from Redis (written by robot_bridge) and exposes
the same Strawberry GraphQL API on port 8000.

Redis key format (written by robot_bridge/main.py):
  robot:{name}:state      -> JSON robot state
  robot:{name}:heartbeat  -> timestamp (existence = ONLINE)
"""
from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from enum import Enum
from typing import AsyncGenerator, Optional
from datetime import datetime, timezone

import redis.asyncio as aioredis
import strawberry
from fastapi import FastAPI
from strawberry.fastapi import GraphQLRouter

# ── Config ────────────────────────────────────────────────────────────────────
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
ROBOTS_CONFIG: dict = json.loads(os.getenv("ROBOTS_CONFIG", "{}"))

# ── Enums ─────────────────────────────────────────────────────────────────────
@strawberry.enum
class RobotConnectionStatus(Enum):
    ONLINE = "ONLINE"
    OFFLINE = "OFFLINE"


@strawberry.enum
class RobotActionStatus(Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    ERROR = "ERROR"


@strawberry.enum
class JobOperation(Enum):
    PICKUP = "PICKUP"
    DELIVERY = "DELIVERY"
    TRAVEL = "TRAVEL"


@strawberry.enum
class OrderStatus(Enum):
    QUEUED = "QUEUED"
    IN_PROGRESS = "IN_PROGRESS"
    DONE = "DONE"
    CANCELLED = "CANCELLED"
    ERROR = "ERROR"


@strawberry.enum
class NodeType(Enum):
    STORAGE = "STORAGE"
    STAGING = "STAGING"
    CHARGING = "CHARGING"
    INTERSECTION = "INTERSECTION"
    OTHER = "OTHER"


# ── GraphQL Types ─────────────────────────────────────────────────────────────
@strawberry.type
class Tag:
    qr_id: str
    timestamp: Optional[datetime] = None


@strawberry.type
class Pose:
    x: float
    y: float
    a: float
    timestamp: Optional[datetime] = None


@strawberry.type
class MobileBaseState:
    tag: Optional[Tag] = None
    pose: Optional[Pose] = None


@strawberry.type
class PiggybackState:
    lift: float = 0.0
    turntable: float = 0.0
    slide: float = 0.0
    hook_left: float = 0.0
    hook_right: float = 0.0
    timestamp: Optional[datetime] = None


@strawberry.type
class RobotCell:
    height: float
    holding: Optional[str] = None  # request UUID or None


@strawberry.type
class Node:
    id: int
    alias: Optional[str] = None
    tag_id: Optional[str] = None
    x: float = 0.0
    y: float = 0.0
    height: float = 0.0
    node_type: NodeType = NodeType.OTHER


@strawberry.type
class Job:
    uuid: str
    status: OrderStatus
    operation: JobOperation
    target_node: Optional[Node] = None
    request_uuid: Optional[str] = None
    handling_robot_name: str = ""


@strawberry.type
class Request:
    uuid: str
    status: OrderStatus
    pickup_uuid: Optional[str] = None
    delivery_uuid: Optional[str] = None
    handling_robot_name: str = ""


@strawberry.type
class Robot:
    name: str
    connection_status: RobotConnectionStatus
    last_action_status: RobotActionStatus
    mobile_base_state: Optional[MobileBaseState] = None
    piggyback_state: Optional[PiggybackState] = None
    autorun: bool = False
    cells: list[RobotCell] = strawberry.field(default_factory=list)
    current_job: Optional[Job] = None
    job_queue: list[Job] = strawberry.field(default_factory=list)


@strawberry.type
class JobOrderResult:
    success: bool
    message: str
    job: Optional[Job] = None


@strawberry.type
class RequestOrderResult:
    success: bool
    message: str
    request: Optional[Request] = None


@strawberry.type
class WarehouseOrderResult:
    success: bool
    message: str
    requests: list[Request] = strawberry.field(default_factory=list)


# ── Input Types ───────────────────────────────────────────────────────────────
@strawberry.input
class PickupOrderInput:
    robot_name: str
    target_node_id: Optional[int] = None
    target_node_alias: Optional[str] = None


@strawberry.input
class DeliveryOrderInput:
    robot_name: str
    cell_level: int
    target_node_id: Optional[int] = None
    target_node_alias: Optional[str] = None


@strawberry.input
class TravelOrderInput:
    robot_name: str
    target_node_id: Optional[int] = None
    target_node_alias: Optional[str] = None


# ── Redis helpers ─────────────────────────────────────────────────────────────
_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    return _redis


def _parse_robot_state(name: str, raw: Optional[str], heartbeat: Optional[str]) -> Robot:
    """Convert Redis state JSON into a Robot GraphQL object."""
    now = datetime.now(timezone.utc)

    # Determine connection status from heartbeat key existence
    conn_status = RobotConnectionStatus("ONLINE") if heartbeat else RobotConnectionStatus("OFFLINE")

    if not raw:
        return Robot(
            name=name,
            connection_status=conn_status,
            last_action_status=RobotActionStatus("IDLE"),
        )

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return Robot(name=name, connection_status=conn_status,
                     last_action_status=RobotActionStatus("IDLE"))

    # Override with Redis state's own connectionStatus if heartbeat exists
    if heartbeat and data.get("connectionStatus") == "ONLINE":
        conn_status = RobotConnectionStatus("ONLINE")
    elif not heartbeat:
        conn_status = RobotConnectionStatus("OFFLINE")

    action_raw = data.get("lastActionStatus", "IDLE")
    try:
        action_status = RobotActionStatus(action_raw)
    except ValueError:
        action_status = RobotActionStatus("IDLE")

    # Mobile base state
    mb = data.get("mobileBaseState") or {}
    tag = None
    qr_id = mb.get("qr_id")
    if qr_id:
        tag = Tag(qr_id=str(qr_id), timestamp=now)

    pose = Pose(x=mb.get("x", 0.0), y=mb.get("y", 0.0),
                a=mb.get("theta", 0.0), timestamp=now)
    mobile_base_state = MobileBaseState(tag=tag, pose=pose)

    # Piggyback state (simplified - real data may differ)
    piggyback_raw = data.get("piggybackState")
    piggyback = None
    if isinstance(piggyback_raw, dict):
        piggyback = PiggybackState(
            lift=piggyback_raw.get("lift", 0.0),
            turntable=piggyback_raw.get("turntable", 0.0),
            slide=piggyback_raw.get("slide", 0.0),
            hook_left=piggyback_raw.get("hook_left", 0.0),
            hook_right=piggyback_raw.get("hook_right", 0.0),
            timestamp=now,
        )

    autorun = bool(data.get("autorun", False))

    return Robot(
        name=name,
        connection_status=conn_status,
        last_action_status=action_status,
        mobile_base_state=mobile_base_state,
        piggyback_state=piggyback,
        autorun=autorun,
    )


async def fetch_robot(name: str) -> Robot:
    r = await get_redis()
    state_key = f"robot:{name}:state"
    heartbeat_key = f"robot:{name}:heartbeat"

    raw, heartbeat = await r.mget(state_key, heartbeat_key)
    return _parse_robot_state(name, raw, heartbeat)


async def fetch_all_robots() -> list[Robot]:
    robot_names = list(ROBOTS_CONFIG.keys())
    return [await fetch_robot(name) for name in robot_names]


# ── GraphQL Schema ────────────────────────────────────────────────────────────
@strawberry.type
class Query:
    @strawberry.field(description="Get a specific robot by name.")
    async def robot(self, name: str) -> Optional[Robot]:
        if name not in ROBOTS_CONFIG:
            return None
        return await fetch_robot(name)

    @strawberry.field(description="Get all robots in the fleet.")
    async def robots(self) -> list[Robot]:
        return await fetch_all_robots()

    @strawberry.field(description="Get all warehouse jobs.")
    async def jobs(self) -> list[Job]:
        return []

    @strawberry.field(description="Get a specific job by UUID.")
    async def job(self, uuid: str) -> Optional[Job]:
        return None

    @strawberry.field(description="Get all warehouse requests.")
    async def requests(self) -> list[Request]:
        return []

    @strawberry.field(description="Get a specific request by UUID.")
    async def request(self, uuid: str) -> Optional[Request]:
        return None


@strawberry.type
class Mutation:
    @strawberry.mutation
    async def send_pickup_order(self, order: PickupOrderInput) -> JobOrderResult:
        return JobOrderResult(success=False, message="Not implemented in simulation mode")

    @strawberry.mutation
    async def send_delivery_order(self, order: DeliveryOrderInput) -> JobOrderResult:
        return JobOrderResult(success=False, message="Not implemented in simulation mode")

    @strawberry.mutation
    async def send_travel_order(self, order: TravelOrderInput) -> JobOrderResult:
        return JobOrderResult(success=False, message="Not implemented in simulation mode")

    @strawberry.mutation
    async def run_robot(self, robot_name: str) -> JobOrderResult:
        return JobOrderResult(success=False, message="Not implemented in simulation mode")

    @strawberry.mutation
    async def set_autorun(self, robot_name: str, autorun: bool) -> Robot:
        return await fetch_robot(robot_name)

    @strawberry.mutation
    async def cancel_current_job(self, robot_name: str) -> JobOrderResult:
        return JobOrderResult(success=False, message="Not implemented in simulation mode")

    @strawberry.mutation
    async def clear_robot_error(self, robot_name: str) -> Robot:
        return await fetch_robot(robot_name)


@strawberry.type
class Subscription:
    @strawberry.subscription(description="Subscribe to all robots' state updates.")
    async def robots(self) -> AsyncGenerator[list[Robot], None]:
        r = await get_redis()
        pubsub = r.pubsub()
        robot_names = list(ROBOTS_CONFIG.keys())
        channels = [f"robot:{name}" for name in robot_names]
        await pubsub.subscribe(*channels)
        try:
            async for message in pubsub.listen():
                if message["type"] == "message":
                    yield await fetch_all_robots()
        finally:
            await pubsub.unsubscribe(*channels)

    @strawberry.subscription(description="Subscribe to a specific robot's state updates.")
    async def robot(self, name: str) -> AsyncGenerator[Optional[Robot], None]:
        if name not in ROBOTS_CONFIG:
            yield None
            return
        r = await get_redis()
        pubsub = r.pubsub()
        channel = f"robot:{name}"
        await pubsub.subscribe(channel)
        try:
            async for message in pubsub.listen():
                if message["type"] == "message":
                    yield await fetch_robot(name)
        finally:
            await pubsub.unsubscribe(channel)


# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    r = await get_redis()
    for _ in range(30):
        try:
            await r.ping()
            print(f"Redis connected at {REDIS_HOST}:{REDIS_PORT}")
            break
        except Exception as e:
            print(f"Waiting for Redis... ({e})")
            import asyncio
            await asyncio.sleep(2)

    print(f"Robots configured: {list(ROBOTS_CONFIG.keys())}")
    yield
    if _redis:
        await _redis.aclose()


schema = strawberry.Schema(query=Query, mutation=Mutation, subscription=Subscription)

graphql_ide = os.getenv("GRAPHQL_IDE", "graphiql")
graphql_router = GraphQLRouter(
    schema,
    graphql_ide=graphql_ide,  # type: ignore[arg-type]
)

app = FastAPI(title="Fleet Gateway", lifespan=lifespan)
app.include_router(graphql_router, prefix="/graphql")


@app.get("/health")
async def health():
    return {"status": "ok", "robots": list(ROBOTS_CONFIG.keys())}
