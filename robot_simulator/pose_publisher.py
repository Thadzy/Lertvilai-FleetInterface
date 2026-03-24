import json
import math
from typing import Optional

import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry
from sensor_msgs.msg import JointState
from std_msgs.msg import String


class PosePublisher(Node):
    """
    Robot simulator node.

    Publishes /odom_qr, /qr_id, and /piggyback_state telemetry.
    Subscribes to /travel_command to receive navigation targets.

    Travel command format (std_msgs/String, msg.data is JSON):
        {"alias": "Q1", "x": 3.5, "y": 2.1}

    The robot moves in a straight line toward the target at nav_speed m/s.
    When it arrives (within arrival_threshold metres) it stops and updates qr_id.
    """

    ARRIVAL_THRESHOLD = 0.05  # metres — consider "arrived" within this distance

    def __init__(self):
        super().__init__('pose_publisher')

        # ── Parameters ────────────────────────────────────────────────────
        self.declare_parameter('publish_rate', 10.0)   # Hz
        self.declare_parameter('nav_speed',    1.0)    # m/s — linear navigation speed
        self.declare_parameter('qr_id',        'DEPOT')

        rate      = self.get_parameter('publish_rate').value
        self._dt  = 1.0 / rate

        # ── Publishers ────────────────────────────────────────────────────
        self.odom_pub     = self.create_publisher(Odometry,   '/odom_qr',        10)
        self.qr_pub       = self.create_publisher(String,     '/qr_id',          10)
        self.piggyback_pub = self.create_publisher(JointState, '/piggyback_state', 10)

        # ── Subscriber ────────────────────────────────────────────────────
        self.create_subscription(String, '/travel_command', self._on_travel_command, 10)

        # ── Navigation state ──────────────────────────────────────────────
        self._current_x: float = 0.0
        self._current_y: float = 0.0
        self._current_yaw: float = 0.0

        self._target_x: Optional[float] = None
        self._target_y: Optional[float] = None
        self._target_alias: str = self.get_parameter('qr_id').value
        self._moving: bool = False

        # ── Timer ─────────────────────────────────────────────────────────
        self.create_timer(self._dt, self._tick)

        self.get_logger().info(
            f'PosePublisher started — publishing at {rate} Hz, '
            f'nav_speed={self.get_parameter("nav_speed").value} m/s'
        )

    # ── Command handler ───────────────────────────────────────────────────

    def _on_travel_command(self, msg: String):
        """Parse a /travel_command JSON string and set the navigation target."""
        raw = msg.data.strip()
        try:
            data = json.loads(raw)
            tx = float(data['x'])
            ty = float(data['y'])
            alias = str(data.get('alias', ''))
        except (json.JSONDecodeError, KeyError, ValueError, TypeError) as exc:
            self.get_logger().error(f'Bad travel command "{raw}": {exc}')
            return

        self._target_x     = tx
        self._target_y     = ty
        self._target_alias = alias
        self._moving       = True

        self.get_logger().info(
            f'Travel command received → {alias} ({tx:.3f}, {ty:.3f})  '
            f'[current: ({self._current_x:.3f}, {self._current_y:.3f})]'
        )

    # ── Main tick ─────────────────────────────────────────────────────────

    def _tick(self):
        self._step_navigation()
        self._publish_odom()
        self._publish_qr()
        self._publish_piggyback()

    def _step_navigation(self):
        """Advance position one tick toward the current target (if any)."""
        if self._target_x is None or not self._moving:
            return

        dx   = self._target_x - self._current_x
        dy   = self._target_y - self._current_y
        dist = math.hypot(dx, dy)

        if dist <= self.ARRIVAL_THRESHOLD:
            # Snap to target and stop
            self._current_x = self._target_x
            self._current_y = self._target_y
            self._moving    = False
            self.get_logger().info(
                f'Arrived at {self._target_alias} '
                f'({self._current_x:.3f}, {self._current_y:.3f})'
            )
            return

        speed = self.get_parameter('nav_speed').value
        step  = speed * self._dt

        self._current_yaw = math.atan2(dy, dx)
        self._current_x  += (dx / dist) * step
        self._current_y  += (dy / dist) * step

    # ── Publishers ────────────────────────────────────────────────────────

    def _publish_odom(self):
        msg = Odometry()
        msg.pose.pose.position.x = self._current_x
        msg.pose.pose.position.y = self._current_y
        msg.pose.pose.position.z = 0.0

        # Quaternion from yaw (z-up convention)
        msg.pose.pose.orientation.z = math.sin(self._current_yaw / 2.0)
        msg.pose.pose.orientation.w = math.cos(self._current_yaw / 2.0)

        if self._moving:
            speed = self.get_parameter('nav_speed').value
            msg.twist.twist.linear.x = speed * math.cos(self._current_yaw)
            msg.twist.twist.linear.y = speed * math.sin(self._current_yaw)

        self.odom_pub.publish(msg)

    def _publish_qr(self):
        msg = String()
        msg.data = self._target_alias
        self.qr_pub.publish(msg)

    def _publish_piggyback(self):
        msg = JointState()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name     = ['lift', 'turntable', 'slide', 'hook_left', 'hook_right']
        msg.position = [0.0, 0.0, 0.0, 0.0, 0.0]
        self.piggyback_pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = PosePublisher()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
