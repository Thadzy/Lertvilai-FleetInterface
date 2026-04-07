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
import asyncio
import logging
import httpx
import time
from contextlib import asynccontextmanager
from enum import Enum
from typing import AsyncGenerator, Optional
from datetime import datetime, timezone

import redis.asyncio as aioredis
import strawberry
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Ensure application-level loggers (route_oracle, vrp_client, etc.) emit INFO
# to stdout.  Uvicorn's dictConfig leaves the root logger without a handler,
# so propagated records would be silently dropped without this call.
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s:%(name)s - %(message)s",
    force=True,  # override any prior config (e.g. from uvicorn startup)
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from strawberry.fastapi import GraphQLRouter

from vrp_client import (
    PickupDeliveryTask,
    VrpSolveRequest,
    solve as vrp_solve,
)
from route_oracle import log_vehicle_routes
from route_oracle import expand_path_with_coords
from route_oracle import _batch_resolve_nodes_with_coords as resolve_nodes

# ── Config ────────────────────────────────────────────────────────────────────
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
ROBOTS_CONFIG: dict = json.loads(os.getenv("ROBOTS_CONFIG", "{}"))
DEFAULT_GRAPH_ID = int(os.getenv("GRAPH_ID", "1"))
log = logging.getLogger(__name__)
ACTION_SYNC_TIMEOUT_S = float(os.getenv("ACTION_SYNC_TIMEOUT_S", "300"))
ACTION_SYNC_POLL_S = 1.0


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
    yaw: float = 0.0
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
    target_x: Optional[float] = None  # Metres — forwarded to robot for navigation
    target_y: Optional[float] = None  # Metres — forwarded to robot for navigation


@strawberry.input
class ExecutePathOrderInput:
    """Closed-loop path execution request.

    The caller provides a high-level VRP path (node IDs). Fleet gateway expands
    it to concrete waypoints via route_oracle and publishes one ``execute_path``
    command for atomic robot-side batch execution.
    """
    robot_name: str
    graph_id: int
    vrp_path: list[int]


# ── Redis helpers ─────────────────────────────────────────────────────────────
_redis: Optional[aioredis.Redis] = None

async def get_redis(force_reconnect: bool = False) -> aioredis.Redis:
    global _redis
    if force_reconnect and _redis is not None:
        try:
            await _redis.aclose()
        except Exception:
            pass
        _redis = None
    if _redis is None:
        _redis = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    return _redis


async def with_redis(label: str, op, fallback=None):
    """
    Execute a Redis operation with one reconnect retry. Returns `fallback`
    instead of raising when fallback is provided.
    """
    for attempt in range(2):
        try:
            r = await get_redis(force_reconnect=(attempt > 0))
            return await op(r)
        except Exception as exc:
            log.error(f"Redis {label} failed (attempt {attempt + 1}/2): {exc}")
            await asyncio.sleep(0.2)
    if fallback is not None:
        return fallback
    raise RuntimeError(f"Redis {label} failed after retries")


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
    if heartbeat:
        status_from_robot = data.get("connectionStatus", "OFFLINE")
        try:
            conn_status = RobotConnectionStatus(status_from_robot)
        except ValueError:
            conn_status = RobotConnectionStatus("OFFLINE")
    else:
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

    # --- Current Job & Queue ---
    current_job = None
    job_queue = []

    raw_job = data.get("currentJob")
    if isinstance(raw_job, dict):
        target_node = None
        raw_node = raw_job.get("targetNode")
        if isinstance(raw_node, dict):
            target_node = Node(
                id=raw_node.get("id", 0),
                alias=raw_node.get("alias"),
                x=raw_node.get("x", 0.0),
                y=raw_node.get("y", 0.0)
            )
        
        current_job = Job(
            uuid=raw_job.get("uuid", "unknown"),
            status=OrderStatus(raw_job.get("status", "QUEUED")),
            operation=JobOperation(raw_job.get("operation", "TRAVEL")),
            target_node=target_node
        )

    raw_queue = data.get("jobQueue")
    if isinstance(raw_queue, list):
        for idx, item in enumerate(raw_queue):
            if isinstance(item, dict):
                job_queue.append(Job(
                    uuid=f"queued-{idx}",
                    status=OrderStatus.QUEUED,
                    operation=JobOperation.TRAVEL,
                    target_node=Node(
                        id=item.get("id", 0),
                        alias=item.get("alias"),
                        x=item.get("x", 0.0),
                        y=item.get("y", 0.0)
                    )
                ))

    return Robot(
        name=name,
        connection_status=conn_status,
        last_action_status=action_status,
        mobile_base_state=mobile_base_state,
        piggyback_state=piggyback,
        autorun=autorun,
        current_job=current_job,
        job_queue=job_queue,
    )


async def fetch_robot(name: str) -> Robot:
    state_key = f"robot:{name}:state"
    heartbeat_key = f"robot:{name}:heartbeat"
    raw, heartbeat = await with_redis(
        f"mget:{name}",
        lambda r: r.mget(state_key, heartbeat_key),
        fallback=(None, None),
    )
    return _parse_robot_state(name, raw, heartbeat)


async def fetch_all_robots() -> list[Robot]:
    # 1. Start with static config robots
    robot_names = set(ROBOTS_CONFIG.keys())
    
    # 2. Discover dynamic robots from Redis heartbeats
    try:
        r = await get_redis()
        # Find all keys matching the heartbeat pattern
        keys = await r.keys("robot:*:heartbeat")
        for key in keys:
            # Extract name: "robot:NAME:heartbeat" -> "NAME"
            parts = key.split(":")
            if len(parts) >= 2:
                robot_names.add(parts[1])
    except Exception as exc:
        log.error(f"Failed to discover robots from Redis: {exc}")

    # 3. Fetch full state for all identified robots
    return [await fetch_robot(name) for name in sorted(list(robot_names))]


async def _dispatch_execute_path_and_wait(
    *,
    robot_name: str,
    graph_id: int,
    vrp_path: list[int],
) -> JobOrderResult:
    """Dispatch a full expanded path and block until robot reaches terminal state.

    This is the closed-loop replacement for legacy waypoint-by-waypoint dispatch.
    Instead of publishing many ``travel`` commands with artificial sleeps, we:
    1) expand the VRP path to concrete waypoints (alias + x + y),
    2) publish one ``execute_path`` payload to Redis,
    3) poll robot runtime status until the action finishes (IDLE) or fails (ERROR).

    Args:
        robot_name: Robot identifier used in Redis channel naming.
        graph_id: Warehouse graph ID for A* expansion in route_oracle.
        vrp_path: High-level VRP node ID path.

    Returns:
        JobOrderResult indicating terminal dispatch outcome.
    """
    waypoints = await expand_path_with_coords(graph_id, vrp_path)
    if not waypoints:
        return JobOrderResult(
            success=False,
            message=(
                "Failed to expand VRP path into executable waypoints. "
                "Dispatch aborted before publish."
            ),
        )

    channel = f"robot:{robot_name}:command"
    payload = json.dumps(
        {
            "op": "execute_path",
            "waypoints": waypoints,
        }
    )

    try:
        await with_redis(
            f"publish:{channel}",
            lambda r: r.publish(channel, payload),
        )
    except Exception as exc:  # noqa: BLE001
        return JobOrderResult(
            success=False,
            message=f"Redis error dispatching execute_path to {robot_name}: {exc}",
        )

    # Closed-loop synchronization:
    # Do not treat dispatch as successful until runtime status settles.
    # IDLE => action completed; ERROR => action failed/timed out downstream.
    started_at = asyncio.get_event_loop().time()
    while (asyncio.get_event_loop().time() - started_at) < ACTION_SYNC_TIMEOUT_S:
        robot = await fetch_robot(robot_name)
        action = robot.last_action_status.value
        connection = robot.connection_status.value

        if connection == RobotConnectionStatus.OFFLINE.value:
            return JobOrderResult(
                success=False,
                message=(
                    f"Robot {robot_name} went OFFLINE while executing batch path. "
                    "Marked as failed."
                ),
            )

        if action == RobotActionStatus.IDLE.value:
            return JobOrderResult(
                success=True,
                message=(
                    f"execute_path dispatched and completed for {robot_name} "
                    f"({len(waypoints)} waypoints)."
                ),
            )

        if action == RobotActionStatus.ERROR.value:
            return JobOrderResult(
                success=False,
                message=(
                    f"Robot {robot_name} reported ERROR during execute_path. "
                    "Marked as failed."
                ),
            )

        await asyncio.sleep(ACTION_SYNC_POLL_S)

    return JobOrderResult(
        success=False,
        message=(
            f"Timed out waiting for {robot_name} to finish execute_path "
            f"(>{ACTION_SYNC_TIMEOUT_S:.0f}s). Marked as failed."
        ),
    )


@strawberry.input
class RequestAliasInput:
    pickup_node_alias: Optional[str] = None
    delivery_node_alias: Optional[str] = None


@strawberry.input
class SendRequestOrderInput:
    robot_name: str
    request_alias: RequestAliasInput


@strawberry.input
class AssignmentInput:
    robot_name: str
    route_node_aliases: list[str]


@strawberry.input
class WarehouseOrderInput:
    assignments: list[AssignmentInput]
    request_aliases: list[RequestAliasInput]


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
    async def execute_path_order(self, order: ExecutePathOrderInput) -> JobOrderResult:
        """Dispatch and synchronize a full path execution in closed loop.

        This mutation supersedes legacy per-waypoint travel loops in backend job
        dispatch. It waits for terminal action status before returning so callers
        can mark job records as DONE/ERROR based on this definitive result.
        """
        if not order.vrp_path or len(order.vrp_path) < 2:
            return JobOrderResult(
                success=False,
                message="vrp_path must contain at least two node IDs.",
            )
        if order.robot_name not in ROBOTS_CONFIG:
            return JobOrderResult(
                success=False,
                message=f"Unknown robot '{order.robot_name}'. Check ROBOTS_CONFIG.",
            )
        return await _dispatch_execute_path_and_wait(
            robot_name=order.robot_name,
            graph_id=order.graph_id,
            vrp_path=order.vrp_path,
        )
    @strawberry.mutation
    async def send_pickup_order(self, order: PickupOrderInput) -> JobOrderResult:
        """Dispatch a pickup order and return the created job."""
        job_uuid = f"pickup-{int(time.time())}"
        channel = f"robot:{order.robot_name}:command"
        command = json.dumps({
            "op": "pickup",
            "topic": "/pickup_command",
            "msg": {
                "target_alias": order.target_node_alias,
                "target_node_id": order.target_node_id,
            },
        })
        try:
            await with_redis(f"publish:{channel}", lambda r: r.publish(channel, command))
            created_job = Job(
                uuid=job_uuid,
                status=OrderStatus.QUEUED,
                operation=JobOperation.PICKUP,
                target_node=Node(id=order.target_node_id or 0, alias=order.target_node_alias)
            )
            return JobOrderResult(success=True, message=f"Pickup dispatched", job=created_job)
        except Exception as exc:
            return JobOrderResult(success=False, message=f"Redis error: {exc}")

    @strawberry.mutation
    async def send_delivery_order(self, order: DeliveryOrderInput) -> JobOrderResult:
        """Dispatch a delivery order and return the created job."""
        job_uuid = f"delivery-{int(time.time())}"
        channel = f"robot:{order.robot_name}:command"
        command = json.dumps({
            "op": "delivery",
            "topic": "/delivery_command",
            "msg": {
                "target_alias": order.target_node_alias,
                "target_node_id": order.target_node_id,
                "cell_level": order.cell_level,
            },
        })
        try:
            await with_redis(f"publish:{channel}", lambda r: r.publish(channel, command))
            created_job = Job(
                uuid=job_uuid,
                status=OrderStatus.QUEUED,
                operation=JobOperation.DELIVERY,
                target_node=Node(id=order.target_node_id or 0, alias=order.target_node_alias)
            )
            return JobOrderResult(success=True, message=f"Delivery dispatched", job=created_job)
        except Exception as exc:
            return JobOrderResult(success=False, message=f"Redis error: {exc}")

    @strawberry.mutation
    async def send_travel_order(self, order: TravelOrderInput) -> JobOrderResult:
        """Dispatch a travel order and return the created job with resolved coordinates."""
        job_uuid = f"travel-{int(time.time())}"
        target_x = order.target_x
        target_y = order.target_y
        target_yaw = 0.0
        
        # Resolve coords if missing (already implemented logic)
        try:
            async with httpx.AsyncClient() as client:
                node_id = order.target_node_id
                if not node_id and order.target_node_alias:
                    url = f"{os.getenv('POSTGREST_URL', 'http://rest:3000')}/wh_nodes"
                    resp = await client.get(url, params={"alias": f"eq.{order.target_node_alias}", "select": "id"}, 
                                         headers={"Authorization": f"Bearer {os.getenv('SUPABASE_SERVICE_KEY', '')}"})
                    if resp.status_code == 200 and resp.json():
                        node_id = resp.json()[0]["id"]
                
                if node_id:
                    node_map = await resolve_nodes(client, DEFAULT_GRAPH_ID, {int(node_id)})
                    if int(node_id) in node_map:
                        target_x = node_map[int(node_id)]["x"]
                        target_y = node_map[int(node_id)]["y"]
                        target_yaw = node_map[int(node_id)].get("yaw", 0.0)
        except Exception as exc:
            log.error(f"Coord resolution failed: {exc}")

        channel = f"robot:{order.robot_name}:command"
        command = json.dumps({
            "op": "travel",
            "topic": "/travel_command",
            "msg": {
                "target_alias": order.target_node_alias,
                "target_node_id": order.target_node_id,
                "target_x": target_x or 0.0,
                "target_y": target_y or 0.0,
                "target_th": target_yaw,
            },
        })
        try:
            await with_redis(f"publish:{channel}", lambda r: r.publish(channel, command))
            created_job = Job(
                uuid=job_uuid,
                status=OrderStatus.QUEUED,
                operation=JobOperation.TRAVEL,
                target_node=Node(id=order.target_node_id or 0, alias=order.target_node_alias, x=target_x or 0.0, y=target_y or 0.0)
            )
            return JobOrderResult(success=True, message="Travel dispatched", job=created_job)
        except Exception as exc:
            return JobOrderResult(success=False, message=f"Redis error: {exc}")

    @strawberry.mutation
    async def send_robot_command(self, robot_name: str, command: str) -> JobOrderResult:
        """Dispatch a control command (PAUSE/RESUME/ESTOP/CANCEL) via Redis pub/sub."""
        normalized = command.upper().strip()
        command_map = {
            "PAUSE": "PAUSE",
            "RESUME": "RESUME",
            "ESTOP": "ESTOP",
            "CANCEL": "CANCEL",
            "CANCEL_ALL": "CANCEL",
        }
        if normalized not in command_map:
            return JobOrderResult(
                success=False,
                message=(
                    f"Unsupported command '{command}'. "
                    "Allowed: PAUSE, RESUME, ESTOP, CANCEL"
                ),
            )

        channel = f"robot:{robot_name}:command"
        payload = json.dumps({
            "op": "control",
            "topic": "/travel_command",
            "msg": {
                "command": command_map[normalized],
            },
        })
        try:
            await with_redis(
                f"publish:{channel}",
                lambda r: r.publish(channel, payload),
            )
            return JobOrderResult(
                success=True,
                message=f"{command_map[normalized]} dispatched to {robot_name}",
            )
        except Exception as exc:  # noqa: BLE001
            return JobOrderResult(
                success=False,
                message=f"Redis error dispatching {normalized} to {robot_name}: {exc}",
            )

    @strawberry.mutation
    async def run_robot(self, robot_name: str) -> JobOrderResult:
        channel = f"robot:{robot_name}:command"
        payload = json.dumps({"op": "control", "topic": "/travel_command", "msg": {"command": "RESUME"}})
        try:
            await with_redis(f"publish:{channel}", lambda r: r.publish(channel, payload))
            return JobOrderResult(success=True, message=f"RESUME dispatched to {robot_name}")
        except Exception as exc:
            return JobOrderResult(success=False, message=f"Redis error: {exc}")

    @strawberry.mutation
    async def set_autorun(self, robot_name: str, autorun: bool) -> Robot:
        channel = f"robot:{robot_name}:command"
        payload = json.dumps({"op": "control", "topic": "/travel_command", "msg": {"command": "RESUME" if autorun else "PAUSE"}})
        try:
            await with_redis(f"publish:{channel}", lambda r: r.publish(channel, payload))
        except Exception as exc:
            log.warning(f"[setAutorun] Redis error for {robot_name}: {exc}")
        return await fetch_robot(robot_name)

    @strawberry.mutation
    async def cancel_current_job(self, robot_name: str) -> JobOrderResult:
        channel = f"robot:{robot_name}:command"
        payload = json.dumps({"op": "control", "topic": "/travel_command", "msg": {"command": "CANCEL"}})
        try:
            await with_redis(f"publish:{channel}", lambda r: r.publish(channel, payload))
            return JobOrderResult(success=True, message=f"CANCEL dispatched to {robot_name}")
        except Exception as exc:
            return JobOrderResult(success=False, message=f"Redis error cancelling {robot_name}: {exc}")

    @strawberry.mutation
    async def clear_robot_error(self, robot_name: str) -> Robot:
        channel = f"robot:{robot_name}:command"
        payload = json.dumps({"op": "control", "topic": "/travel_command", "msg": {"command": "CLEAR_ERROR"}})
        try:
            await with_redis(f"publish:{channel}", lambda r: r.publish(channel, payload))
        except Exception as exc:
            log.warning(f"[clearRobotError] Redis publish failed for {robot_name}: {exc}")
        return await fetch_robot(robot_name)

    @strawberry.mutation
    async def send_warehouse_order(self, warehouse_order: WarehouseOrderInput) -> WarehouseOrderResult:
        """Process a batch warehouse order for multiple robots."""
        success_count = 0
        total_robots = len(warehouse_order.assignments)
        
        try:
            async with httpx.AsyncClient() as client:
                for asn in warehouse_order.assignments:
                    robot_name = asn.robot_name
                    aliases = asn.route_node_aliases
                    
                    if not aliases:
                        continue

                    # 1. Resolve all aliases to IDs and Coords
                    log.info(f"[WarehouseOrder] Processing {robot_name} with {len(aliases)} nodes")
                    
                    # Fetch nodes to get IDs and Coords in one go
                    id_list = []
                    alias_to_id = {}
                    
                    # Lookup IDs for these aliases
                    for alias in aliases:
                        resp = await client.get(
                            f"{os.getenv('POSTGREST_URL', 'http://rest:3000')}/wh_nodes",
                            params={"alias": f"eq.{alias}", "select": "id"},
                            headers={"Authorization": f"Bearer {os.getenv('SUPABASE_SERVICE_KEY', '')}"}
                        )
                        if resp.status_code == 200 and resp.json():
                            node_id = resp.json()[0]["id"]
                            id_list.append(int(node_id))
                            alias_to_id[alias] = int(node_id)

                    # 2. Get full coordinate data
                    if id_list:
                        node_map = await resolve_nodes(client, DEFAULT_GRAPH_ID, set(id_list))
                        waypoints = []
                        for alias in aliases:
                            nid = alias_to_id.get(alias)
                            if nid and nid in node_map:
                                waypoints.append(node_map[nid])
                        
                        # 3. Publish to Redis as an 'execute_path' batch command
                        channel = f"robot:{robot_name}:command"
                        payload = json.dumps({
                            "op": "execute_path",
                            "waypoints": waypoints
                        })
                        await with_redis(f"publish:{channel}", lambda r: r.publish(channel, payload))
                        success_count += 1
                        log.info(f"[WarehouseOrder] Successfully dispatched path to {robot_name}")

            return WarehouseOrderResult(
                success=True,
                message=f"Successfully dispatched orders to {success_count}/{total_robots} robots."
            )
        except Exception as exc:
            log.error(f"[WarehouseOrder] Error: {exc}")
            return WarehouseOrderResult(
                success=False,
                message=f"Failed to process warehouse order: {exc}"
            )

    @strawberry.mutation
    async def send_request_order(self, request_order: SendRequestOrderInput) -> JobOrderResult:
        """Dispatch a combined pickup-delivery request to a robot via Redis pub/sub."""
        robot_name = request_order.robot_name
        channel = f"robot:{robot_name}:command"
        payload = json.dumps({
            "op": "request",
            "topic": "/request_command",
            "msg": {
                "pickup_alias": request_order.request_alias.pickup_node_alias,
                "delivery_alias": request_order.request_alias.delivery_node_alias,
            },
        })
        try:
            await with_redis(f"publish:{channel}", lambda r: r.publish(channel, payload))
            return JobOrderResult(success=True, message=f"Request order dispatched to {robot_name}")
        except Exception as exc:
            return JobOrderResult(success=False, message=f"Redis error dispatching request to {robot_name}: {exc}")


@strawberry.type
class Subscription:
    @strawberry.subscription(description="Subscribe to all robots' state updates.")
    async def robots(self) -> AsyncGenerator[list[Robot], None]:
        robot_names = list(ROBOTS_CONFIG.keys())
        channels = [f"robot:{name}" for name in robot_names]
        while True:
            pubsub = None
            try:
                r = await get_redis()
                pubsub = r.pubsub()
                await pubsub.subscribe(*channels)
                async for message in pubsub.listen():
                    if message.get("type") == "message":
                        yield await fetch_all_robots()
            except Exception as exc:
                log.error(f"Redis subscription error (robots): {exc}. Reconnecting...")
                await asyncio.sleep(0.5)
            finally:
                if pubsub is not None:
                    try:
                        await pubsub.unsubscribe(*channels)
                    except Exception:
                        pass
                    try:
                        await pubsub.aclose()
                    except Exception:
                        pass

    @strawberry.subscription(description="Subscribe to a specific robot's state updates.")
    async def robot(self, name: str) -> AsyncGenerator[Optional[Robot], None]:
        if name not in ROBOTS_CONFIG:
            yield None
            return
        channel = f"robot:{name}"
        while True:
            pubsub = None
            try:
                r = await get_redis()
                pubsub = r.pubsub()
                await pubsub.subscribe(channel)
                async for message in pubsub.listen():
                    if message.get("type") == "message":
                        yield await fetch_robot(name)
            except Exception as exc:
                log.error(f"Redis subscription error (robot:{name}): {exc}. Reconnecting...")
                await asyncio.sleep(0.5)
            finally:
                if pubsub is not None:
                    try:
                        await pubsub.unsubscribe(channel)
                    except Exception:
                        pass
                    try:
                        await pubsub.aclose()
                    except Exception:
                        pass


# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    for _ in range(30):
        try:
            r = await get_redis(force_reconnect=(_ > 0))
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(graphql_router, prefix="/graphql")


@app.get("/health")
async def health():
    return {"status": "ok", "robots": list(ROBOTS_CONFIG.keys())}


# ── VRP REST API ───────────────────────────────────────────────────────────────

class _VrpTaskPayload(BaseModel):
    """A single pickup-delivery pair in a VRP solve request body."""
    task_id: Optional[int] = None
    pickup: int
    delivery: int


class _VrpSolveBody(BaseModel):
    """Request body for ``POST /vrp/solve``.

    Attributes:
        graph_id: Warehouse graph ID in PostgreSQL.
        num_vehicles: Number of robots available.
        pickups_deliveries: List of pickup/delivery node ID pairs.
        robot_locations: Starting node ID per vehicle.
        vehicle_capacity: Max simultaneous items per vehicle.
    """
    graph_id: int
    num_vehicles: int
    pickups_deliveries: list[_VrpTaskPayload]
    robot_locations: Optional[list[int]] = None
    vehicle_capacity: Optional[int] = None


@app.post("/vrp/solve")
async def vrp_solve_endpoint(body: _VrpSolveBody) -> JSONResponse:
    """Solve a VRP instance with pre-validation and automatic task decomposition.

    This endpoint wraps the C++ OR-Tools VRP server with:

    * **Pre-flight validation**: catches self-loops, empty queues, overcapacity.
    * **Structured error codes**: returns ``error_code`` + ``error_message``
      instead of raw HTTP 400 bodies.
    * **Decomposition fallback**: when two tasks share the same pickup node,
      the request is automatically split and results are merged.

    Request body (JSON):

    .. code-block:: json

        {
            "graph_id": 1,
            "num_vehicles": 1,
            "pickups_deliveries": [
                {"task_id": 1, "pickup": 62, "delivery": 95},
                {"task_id": 2, "pickup": 62, "delivery": 80}
            ],
            "robot_locations": [1],
            "vehicle_capacity": 10
        }

    Successful response (200):

    .. code-block:: json

        {
            "success": true,
            "paths": [[1, 62, 95, 80, 1]],
            "decomposed": false
        }

    Error response (422 or 200 with ``success: false``):

    .. code-block:: json

        {
            "success": false,
            "error_code": "OVERCAPACITY",
            "error_message": "Overcapacity: 5 tasks but fleet handles at most 4..."
        }
    """
    # Build the typed request object; constructor validates self-loops
    try:
        tasks = [
            PickupDeliveryTask(
                pickup_node_id=t.pickup,
                delivery_node_id=t.delivery,
                task_id=t.task_id,
            )
            for t in body.pickups_deliveries
        ]
    except ValueError as exc:
        return JSONResponse(
            status_code=422,
            content={
                "success": False,
                "error_code": "VALIDATION_ERROR",
                "error_message": str(exc),
            },
        )

    req = VrpSolveRequest(
        graph_id=body.graph_id,
        num_vehicles=body.num_vehicles,
        tasks=tasks,
        robot_locations=body.robot_locations,
        vehicle_capacity=body.vehicle_capacity,
    )

    result = await vrp_solve(req)

    if result.success:
        # Derive a display name for each vehicle.
        # Uses robot names from ROBOTS_CONFIG when available, else "Vehicle-N".
        robot_names = list(ROBOTS_CONFIG.keys())
        vehicle_names = [
            robot_names[i] if i < len(robot_names) else f"Vehicle-{i + 1}"
            for i in range(len(result.paths))
        ]

        # Fire-and-forget: expand A* segments and log them without blocking
        # the HTTP response.  Any error inside log_vehicle_routes is caught
        # internally and emitted as a warning — it will never propagate here.
        asyncio.create_task(
            log_vehicle_routes(
                graph_id=body.graph_id,
                vehicle_names=vehicle_names,
                paths=result.paths,
            )
        )

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "paths": result.paths,
                "decomposed": result.decomposed,
            },
        )

    # Map validation/overcapacity errors to 422; solver errors to 400
    status = 422 if result.error_code == "VALIDATION_ERROR" else 400
    return JSONResponse(
        status_code=status,
        content={
            "success": False,
            "error_code": result.error_code,
            "error_message": result.error_message,
        },
    )
