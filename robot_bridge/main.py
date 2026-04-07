#!/usr/bin/env python3
"""
Robot Bridge Service (Updated for Multi-Topic & Correct Coords)
==============================================================
"""

import asyncio
import json
import logging
import math
import os
import time
import redis.asyncio as redis_async

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ---------- Config ----------
ROBOT_NAME = os.getenv("ROBOT_NAME", "FACOBOT")
ROBOT_HOST = os.getenv("ROBOT_HOST", "robot_simulator")
ROBOT_PORT = int(os.getenv("ROBOT_PORT", "9090"))
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
HEARTBEAT_TTL = int(os.getenv("HEARTBEAT_TTL", "10"))
ODOM_STALE_TIMEOUT = float(os.getenv("ODOM_STALE_TIMEOUT", "5"))
REDIS_RETRY_DELAY = float(os.getenv("REDIS_RETRY_DELAY", "2"))

ROSBRIDGE_URI = f"ws://{ROBOT_HOST}:{ROBOT_PORT}"

ARRIVAL_TOLERANCE: float = float(os.getenv("ARRIVAL_TOLERANCE", "0.15"))
WAYPOINT_TIMEOUT: float = float(os.getenv("WAYPOINT_TIMEOUT", "60.0"))
POLL_INTERVAL: float = float(os.getenv("POLL_INTERVAL", "0.5"))

# ---------- State ----------
robot_state = {
    "name": ROBOT_NAME,
    "connectionStatus": "ONLINE",
    "lastActionStatus": "IDLE",
    "mobileBaseState": {
        "x": 0.0,
        "y": 0.0,
        "theta": 0.0,
        "qr_id": None,
        "speed": 0.0,
    },
    "piggybackState": False,
    "autorun": False,
    "currentJob": None,
    "jobQueue": [],
}
last_odom_at = 0.0
_redis_client: redis_async.Redis | None = None


def _safe_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


async def get_redis_client(force_reconnect: bool = False) -> redis_async.Redis:
    global _redis_client
    if force_reconnect and _redis_client is not None:
        try: await _redis_client.aclose()
        except: pass
        _redis_client = None
    if _redis_client is None:
        _redis_client = redis_async.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    return _redis_client


async def push_to_redis() -> None:
    key_state = f"robot:{ROBOT_NAME}:state"
    key_heartbeat = f"robot:{ROBOT_NAME}:heartbeat"
    state_json = json.dumps(robot_state)
    try:
        r = await get_redis_client()
        pipe = r.pipeline()
        pipe.set(key_state, state_json, ex=HEARTBEAT_TTL * 2)
        if robot_state["connectionStatus"] == "ONLINE":
            pipe.set(key_heartbeat, str(time.time()), ex=HEARTBEAT_TTL)
        else:
            pipe.delete(key_heartbeat)
        pipe.publish(f"robot:{ROBOT_NAME}", state_json)
        await pipe.execute()
    except Exception as exc:
        log.error(f"Redis publish failed: {exc}")


async def _receive_topics(ws):
    global last_odom_at
    async for raw in ws:
        try:
            msg = json.loads(raw)
            topic = msg.get("topic")
            data = msg.get("msg", {})
            if topic == "/odom_qr":
                pos = data.get("pose", {}).get("pose", {}).get("position", {})
                twist = data.get("twist", {}).get("twist", {}).get("linear", {})
                robot_state["mobileBaseState"]["x"] = round(_safe_float(pos.get("x")), 4)
                robot_state["mobileBaseState"]["y"] = round(_safe_float(pos.get("y")), 4)
                robot_state["mobileBaseState"]["theta"] = round(_safe_float(pos.get("z")), 4)
                speed = (_safe_float(twist.get("x"))**2 + _safe_float(twist.get("y"))**2)**0.5
                robot_state["mobileBaseState"]["speed"] = round(speed, 4)
                robot_state["connectionStatus"] = "ONLINE"
                last_odom_at = time.time()
                robot_state["lastActionStatus"] = "RUNNING" if speed > 0.01 else "IDLE"
            elif topic == "/qr_id":
                robot_state["mobileBaseState"]["qr_id"] = data.get("data")
            await push_to_redis()
        except: continue


async def _publish_travel(ws, topic: str, alias: str, x: float, y: float, th: float = 0.0) -> None:
    inner_cmd = {"x": round(float(x), 4), "y": round(float(y), 4), "th": round(float(th), 4), "method": "goto"}
    command_data = json.dumps(inner_cmd)
    ros_payload = json.dumps({
        "op": "publish", "topic": topic, "type": "std_msgs/msg/String",
        "msg": {"data": command_data}
    })
    log.info(f"→ ROS2 {topic} | target={alias} | payload: {command_data}")
    await ws.send(ros_payload)


async def _execute_path_waypoints(ws, waypoints: list[dict]) -> None:
    robot_state["jobQueue"] = waypoints[:]
    await push_to_redis()
    for idx, wp in enumerate(waypoints, start=1):
        alias = str(wp.get("alias") or "")
        tx, ty, th = _safe_float(wp.get("x")), _safe_float(wp.get("y")), _safe_float(wp.get("yaw"))
        robot_state["currentJob"] = {"uuid": f"job-{idx}", "operation": "TRAVEL", "status": "IN_PROGRESS", "targetNode": {"alias": alias, "x": tx, "y": ty}}
        if robot_state["jobQueue"]: robot_state["jobQueue"].pop(0)
        await push_to_redis()
        await _publish_travel(ws, "/travel_command", alias, tx, ty, th)
        deadline = time.time() + WAYPOINT_TIMEOUT
        while True:
            dist = math.hypot(_safe_float(robot_state["mobileBaseState"]["x"]) - tx, _safe_float(robot_state["mobileBaseState"]["y"]) - ty)
            if dist <= ARRIVAL_TOLERANCE: break
            if time.time() > deadline:
                robot_state["lastActionStatus"] = "ERROR"
                await push_to_redis()
                return
            await asyncio.sleep(POLL_INTERVAL)
    robot_state["lastActionStatus"] = "IDLE"
    robot_state["currentJob"] = None
    await push_to_redis()


_active_path_task: asyncio.Task | None = None

async def _command_relay(ws):
    global _active_path_task
    channel = f"robot:{ROBOT_NAME}:command"
    last_target = None
    r = await get_redis_client()
    pubsub = r.pubsub()
    await pubsub.subscribe(channel)
    async for message in pubsub.listen():
        if message.get("type") != "message": continue
        cmd = json.loads(message.get("data"))
        op = cmd.get("op")
        if op == "travel":
            m = cmd.get("msg", {})
            topic = cmd.get("topic", "/travel_command")
            tx, ty, th = _safe_float(m.get("target_x")), _safe_float(m.get("target_y")), _safe_float(m.get("target_th"))
            last_target = {"alias": m.get("target_alias"), "x": tx, "y": ty, "th": th, "topic": topic}
            await _publish_travel(ws, topic, str(m.get("target_alias")), tx, ty, th)
        elif op == "execute_path":
            wps = cmd.get("waypoints", [])
            if _active_path_task and not _active_path_task.done(): _active_path_task.cancel()
            _active_path_task = asyncio.create_task(_execute_path_waypoints(ws, wps))
        elif op in {"pickup", "delivery", "request"}:
            topic = cmd.get("topic", f"/{op}_command")
            await ws.send(json.dumps({"op": "publish", "topic": topic, "type": "std_msgs/msg/String", "msg": {"data": json.dumps(cmd.get("msg", {}))}}))
        elif op == "control":
            action = str(cmd.get("msg", {}).get("command", "")).upper()
            if action in {"PAUSE", "ESTOP", "CANCEL"}:
                if _active_path_task: _active_path_task.cancel()
                curr = robot_state["mobileBaseState"]
                await _publish_travel(ws, "/travel_command", "STOP", curr["x"], curr["y"])


async def main():
    import websockets
    while True:
        try:
            async with websockets.connect(ROSBRIDGE_URI) as ws:
                for t, mt in [("/odom_qr", "nav_msgs/msg/Odometry"), ("/qr_id", "std_msgs/msg/String")]:
                    await ws.send(json.dumps({"op": "subscribe", "topic": t, "type": mt}))
                await asyncio.gather(_receive_topics(ws), _command_relay(ws))
        except: await asyncio.sleep(3)

if __name__ == "__main__":
    asyncio.run(main())
