/**
 * Fleet Controller - Production-Grade Robot Fleet Visualization
 * ==============================================================
 *
 * This component provides real-time visualization of the robot fleet
 * on the warehouse map. It uses React Flow for the interactive canvas
 * and connects to the Fleet Gateway via MQTT.
 *
 * Performance Optimizations:
 * - Memoized node types and components to prevent re-renders
 * - Batched robot position updates (via useFleetSocket)
 * - Stable callbacks with useCallback to prevent child re-subscriptions
 *
 * @author WCS Team
 * @version 2.1.0 (Added Fleet Table)
 */

import React, { useEffect, useState, useCallback, useMemo, memo, useRef } from "react";
import {
  useReactFlow,
  Panel,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import WarehouseGraph, { type WarehouseGraphOnLoadPayload } from "./WarehouseGraph";
import {
  Truck,
  PauseCircle,
  PlayCircle,
  AlertOctagon,
  Battery,
  Wifi,
  Activity,
  WifiOff,
  RefreshCw,
  Map as MapIcon,
  ChevronsRight,
  Terminal,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
} from "lucide-react";

import { supabase } from "../lib/supabaseClient";
import { useFleetSocket, type ConnectionStatus } from "../hooks/useFleetSocket";
import { cancelAllDispatches, setFleetPaused } from "../utils/fleetGateway";
import { type GQLRobot, type HardResetProgress } from "../hooks/useFleetGateway";


// ============================================
// TYPE DEFINITIONS
// ============================================

/** Merged robot data combining DB metadata and live MQTT status */
interface FleetRobot {
  id: number;
  name: string;
  status: "idle" | "busy" | "offline" | "error";
  battery: number;
  x: number;
  y: number;
  currentTask: string;
  isActive: boolean;
  activePath?: string[]; // Readable sequence of node aliases (e.g. ["W1", "W2", "S3"])
}

/** Props for the custom RobotNode */
interface RobotNodeData {
  label: string;
  status: FleetRobot["status"];
  battery: number;
}

// ============================================
// CONSTANTS
// ============================================

/** Map scale factor (meters to pixels) */
const MAP_SCALE = 100;

/** Path polling interval in milliseconds */
const PATH_POLL_INTERVAL_MS = 1000;



// ============================================
// MEMOIZED SUB-COMPONENTS
// ============================================

/** Status colors for robot markers */
const ROBOT_STATUS_COLORS: Record<FleetRobot["status"], string> = {
  idle: "bg-green-500 border-green-300",
  busy: "bg-blue-500 border-blue-300",
  offline: "bg-gray-400 border-gray-300",
  error: "bg-red-500 border-red-300",
} as const;

/** Per-vehicle accent colors for HUD and path edges */
const VEHICLE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#a855f7", "#ef4444"];

/**
 * Robot Node - Animated robot markers with pulsing ring on BUSY status.
 */
const RobotNode = memo<NodeProps<RobotNodeData>>(({ data }) => {
  const { label, status, battery } = data;
  const color = ROBOT_STATUS_COLORS[status] || ROBOT_STATUS_COLORS.offline;
  const isBusy = status === "busy";

  return (
    <div className="relative flex flex-col items-center justify-center pointer-events-none select-none">
      {/* Pulsing ring - only when BUSY */}
      {isBusy && (
        <>
          <div className="absolute w-14 h-14 rounded-full bg-blue-400/30 animate-ping" style={{ animationDuration: "1.2s" }} />
          <div className="absolute w-12 h-12 rounded-full bg-blue-400/20 animate-ping" style={{ animationDuration: "1.6s", animationDelay: "0.3s" }} />
        </>
      )}

      {/* Robot Label */}
      <div className="absolute -top-9 bg-gray-900/95 text-white text-[10px] font-bold px-2.5 py-1 rounded-lg shadow-lg backdrop-blur-sm whitespace-nowrap z-50 border border-white/10">
        {label}
      </div>

      {/* Robot Body */}
      <div
        className={`relative w-11 h-11 ${color} rounded-xl shadow-2xl flex items-center justify-center border-2 z-10`}
        style={{ transition: "background-color 0.3s" }}
      >
        <Truck size={22} className="text-white drop-shadow-sm" />
        {/* Status dot */}
        <div className={`absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full border-2 border-white shadow ${isBusy ? "bg-yellow-400 animate-pulse" : status === "idle" ? "bg-green-300" : "bg-gray-300"}`} />
      </div>

      {/* Battery bar */}
      <div className="absolute -bottom-7 flex flex-col items-center gap-0.5">
        <div className="w-10 h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${battery > 50 ? "bg-green-400" : battery > 20 ? "bg-yellow-400" : "bg-red-400"}`}
            style={{ width: `${battery}%` }}
          />
        </div>
        <span className="text-[8px] text-gray-300 font-mono">{battery}%</span>
      </div>

      <Handle type="source" position={Position.Bottom} id="mobile-source" style={{ opacity: 0, top: "50%", left: "50%" }} />
      <Handle type="target" position={Position.Top} id="mobile-target" style={{ opacity: 0, top: "50%", left: "50%" }} />
    </div>
  );
});
RobotNode.displayName = "RobotNode";

/**
 * AutoFitView - null-rendering child of ReactFlow that calls fitView when simulation starts.
 * Must live inside <ReactFlow> to use useReactFlow().
 */
const AutoFitView = memo(({ trigger }: { trigger: boolean }) => {
  const { fitView } = useReactFlow();
  // Initialize from current trigger so we don't fire fitView on mount when
  // simulation routes are already loaded (e.g. switching back to Fleet tab).
  const prev = useRef(trigger);
  useEffect(() => {
    if (trigger && !prev.current) {
      setTimeout(() => fitView({ padding: 0.15, duration: 800 }), 200);
    }
    prev.current = trigger;
  }, [trigger, fitView]);
  return null;
});
AutoFitView.displayName = "AutoFitView";

/**
 * TrailNode — tiny colored dot marking a past robot position.
 */
const TrailNode = memo<NodeProps<{ opacity: number; color: string }>>(({ data }) => (
  <div
    style={{
      width: 8, height: 8,
      borderRadius: '50%',
      backgroundColor: data.color,
      opacity: data.opacity,
      pointerEvents: 'none',
    }}
  />
));
TrailNode.displayName = "TrailNode";


/**
 * Connection Status Badge - Shows MQTT connection state.
 */
const ConnectionStatusBadge = memo<{
  status: ConnectionStatus;
  reconnectAttempts: number;
  onReconnect: () => void;
}>(({ status, reconnectAttempts, onReconnect }) => {
  const statusConfig = {
    connected: {
      icon: Wifi,
      color: "text-green-500",
      bg: "bg-green-50",
      text: "CONNECTED",
    },
    connecting: {
      icon: RefreshCw,
      color: "text-amber-500",
      bg: "bg-amber-50",
      text: "CONNECTING...",
    },
    reconnecting: {
      icon: RefreshCw,
      color: "text-amber-500",
      bg: "bg-amber-50",
      text: `RECONNECTING (${reconnectAttempts})`,
    },
    disconnected: {
      icon: WifiOff,
      color: "text-red-500",
      bg: "bg-red-50",
      text: "DISCONNECTED",
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;
  const isAnimated = status === "connecting" || status === "reconnecting";

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${config.bg} border border-gray-200 dark:border-white/10`}
    >
      <Icon
        size={14}
        className={`${config.color} ${isAnimated ? "animate-spin" : ""}`}
      />
      <span className={`text-xs font-semibold ${config.color}`}>
        {config.text}
      </span>
      {status === "disconnected" && (
        <button
          onClick={onReconnect}
          className="ml-1 text-[10px] bg-slate-200 hover:bg-slate-300 px-2 py-0.5 rounded transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
});
ConnectionStatusBadge.displayName = "ConnectionStatusBadge";

/**
 * Robot Table Row - Individual robot data.
 */
const RobotTableRow = memo<{
  robot: FleetRobot;
  onCommand: (robotId: number, command: string, robotName: string) => void;
  gqlRobot?: GQLRobot;
  onHardReset?: () => void;
  isResetting?: boolean;
  isActive?: boolean;
}>(({ robot, onCommand, gqlRobot, onHardReset, isResetting, isActive }) => {
  const handlePause = useCallback(
    () => onCommand(robot.id, "PAUSE", robot.name),
    [robot.id, robot.name, onCommand],
  );
  const handleResume = useCallback(
    () => onCommand(robot.id, "RESUME", robot.name),
    [robot.id, robot.name, onCommand],
  );
  const handleEstop = useCallback(
    () => onCommand(robot.id, "ESTOP", robot.name),
    [robot.id, robot.name, onCommand],
  );

  return (
    <tr className={`border-b border-slate-50 last:border-0 transition-colors ${
      isActive
        ? 'bg-blue-500/5 dark:bg-blue-500/10 hover:bg-blue-500/10 dark:hover:bg-blue-500/15'
        : 'hover:bg-gray-100 dark:bg-white/5/50'
    }`}>
      {/* Robot Name & ID */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {isActive && (
            <span className="w-1 h-full min-h-[32px] rounded-full bg-blue-500 shrink-0" />
          )}
          <div className={`p-1.5 rounded-lg ${robot.status === 'idle' ? 'bg-green-100 text-green-600' :
            robot.status === 'busy' ? 'bg-blue-100 text-blue-600' :
              'bg-gray-50 dark:bg-[#09090b] text-gray-900 dark:text-white transition-colors text-gray-500 dark:text-gray-400'
            }`}>
            <Truck size={16} />
          </div>
          <div>
            <div className="font-bold text-xs text-gray-900 dark:text-white">{robot.name}</div>
            <div className="text-[10px] text-gray-500 dark:text-gray-400 font-mono">ID: {robot.id}</div>
          </div>
        </div>
      </td>

      {/* Status Badge — MQTT status + GQL overlay */}
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <span
            className={`px-2 py-1 rounded text-[10px] font-bold uppercase w-fit ${robot.status === "idle"
              ? "bg-green-100 text-green-600"
              : robot.status === "busy"
                ? "bg-blue-100 text-blue-600"
                : "bg-red-100 text-red-600"
              }`}
          >
            {robot.status}
          </span>
          {gqlRobot && (
            <div className="flex gap-1">
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold w-fit ${gqlRobot.connectionStatus === 'ONLINE' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400' : 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-500'}`}>
                {gqlRobot.connectionStatus}
              </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold w-fit ${gqlRobot.lastActionStatus === 'IDLE' ? 'bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-slate-400' : gqlRobot.lastActionStatus === 'OPERATING' ? 'bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400' : 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-400'}`}>
                {gqlRobot.lastActionStatus}
              </span>
            </div>
          )}
        </div>
      </td>

      {/* Battery */}
      <td className="px-4 py-3">
        <div className={`flex items-center gap-1.5 text-xs font-mono ${robot.battery > 20 ? 'text-slate-600' : 'text-red-500 font-bold'
          }`}>
          <Battery size={14} className={robot.battery > 20 ? 'text-green-500' : 'text-red-500'} />
          {robot.battery}%
        </div>
      </td>

      {/* Current Task & Path */}
      <td className="px-4 py-3 w-1/3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase">
            <Activity size={10} /> {robot.currentTask}
          </div>

          {/* Active Path Sequence */}
          {robot.activePath && robot.activePath.length > 0 ? (
            <div className="flex items-center gap-1 text-[10px] text-slate-600 font-mono bg-white border border-gray-200 dark:border-white/10 rounded px-2 py-1 shadow-sm overflow-x-auto max-w-[240px] whitespace-nowrap">
              <MapIcon size={10} className="text-blue-400 shrink-0" />
              {robot.activePath.map((node, i) => (
                <React.Fragment key={i}>
                  <span className={i === 0 ? "font-bold text-blue-600" : ""}>{node}</span>
                  {i < robot.activePath!.length - 1 && (
                    <ChevronsRight size={10} className="text-slate-300 shrink-0" />
                  )}
                </React.Fragment>
              ))}
            </div>
          ) : (
            <span className="text-[10px] text-slate-300 italic">No active path</span>
          )}
        </div>
      </td>

      {/* Actions */}
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={handlePause}
            className="p-1.5 text-amber-600 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded transition-colors"
            title="Pause Robot"
          >
            <PauseCircle size={16} />
          </button>
          <button
            onClick={handleResume}
            className="p-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded transition-colors"
            title="Resume Robot"
          >
            <PlayCircle size={16} />
          </button>
          <div className="w-px h-4 bg-slate-200 mx-1" />
          <button
            onClick={handleEstop}
            className="p-1.5 text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded transition-colors"
            title="EMERGENCY STOP"
          >
            <AlertOctagon size={16} />
          </button>
          {onHardReset && (
            <>
              <div className="w-px h-4 bg-slate-200 mx-1" />
              <button
                onClick={onHardReset}
                disabled={isResetting}
                className="p-1.5 text-orange-600 bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Hard Reset (4-step recovery)"
              >
                {isResetting
                  ? <Loader2 size={16} className="animate-spin" />
                  : <RotateCcw size={16} />}
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
});
RobotTableRow.displayName = "RobotTableRow";


// ============================================
// MAIN COMPONENT
// ============================================

interface FleetControllerProps {
  graphId: number
  simulationRoutes?: number[][] | null;
  gqlRobots?: GQLRobot[];
  simMode?: boolean;
  onHardReset?: (robotName: string, onProgress: (steps: HardResetProgress[]) => void) => Promise<void>;
  activeRobotName?: string;
}

const FleetController: React.FC<FleetControllerProps> = ({ graphId, simulationRoutes, gqlRobots, simMode, onHardReset, activeRobotName }) => {
  // --- EXTRA NODE TYPES passed into WarehouseGraph ---
  const extraNodeTypes = useMemo(
    () => ({ robotNode: RobotNode, trailNode: TrailNode }),
    [],
  );

  // --- PATH TRAIL ---
  const trailsRef = useRef<Map<string, { x: number; y: number }[]>>(new Map());
  const MAX_TRAIL_POINTS = 20;

  // --- STATE ---
  const [nodesLoaded, setNodesLoaded] = useState(false);

  // Track active paths per robot (robotId -> list of node aliases)
  const [robotPathDetails, setRobotPathDetails] = useState<Map<number, string[]>>(new Map());

  /**
   * Overlay nodes (robot markers + trail dots) injected into WarehouseGraph.
   * Separate from base graph nodes, which WarehouseGraph manages internally.
   */
  const [overlayNodes, setOverlayNodes] = useState<Node[]>([]);

  /**
   * Overlay edges (path highlights, trail edges, sim edges) injected into WarehouseGraph.
   * Base graph edges are managed by WarehouseGraph.
   */
  const [overlayEdges, setOverlayEdges] = useState<Edge[]>([]);

  // MQTT Hook (production-grade)
  const {
    connectionStatus,
    robotStates,
    logs,
    reconnectAttempts,
    publishCommand,
    forceReconnect,
    addLog,
  } = useFleetSocket();

  // Hard Reset state — maps robotName → progress steps
  const [hardResetStates, setHardResetStates] = useState<Map<string, HardResetProgress[]>>(new Map());
  // Mobile logs toggle
  const [showLogs, setShowLogs] = useState(false);

  // --- REFS (to avoid stale closures) ---
  /** Canvas positions of all base graph nodes, populated by WarehouseGraph.onLoad. */
  const nodePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  /** Maps wh_nodes.id → alias. Populated by WarehouseGraph.onLoad. */
  const nodeAliasMapRef = useRef<Map<number, string>>(new Map());
  /** Maps wh_cells.id → wh_nodes.id. Populated by WarehouseGraph.onLoad. */
  const cellMapRef = useRef<Map<number, number>>(new Map());
  /** robotsRef keeps fetchPaths interval from restarting on every 200ms robot update. */
  const robotsRef = useRef<FleetRobot[]>([]);

  /**
   * Callback from WarehouseGraph once the base graph is loaded.
   * Populates refs used by simulation and path-fetch intervals so those
   * effects do not need to restart when robot telemetry updates arrive.
   */
  const handleGraphLoad = useCallback((payload: WarehouseGraphOnLoadPayload) => {
    nodePositionsRef.current = payload.nodePositions;
    nodeAliasMapRef.current = payload.nodeAliasMap;
    cellMapRef.current = payload.cellMap;
    setNodesLoaded(true);
    console.log('[FleetController] Base graph loaded:', payload.baseNodes.length, 'nodes');
  }, []);

  // --- BUILD ROBOT LIST FROM LIVE GQL DATA (source of truth) ---
  //
  // gqlRobots (from useFleetGateway polling) is authoritative for which robots
  // exist and what their names are.  The DB table (wh_robots) is intentionally
  // NOT used here — stale names like "FACOBOT" in the DB would shadow the real
  // gateway names and cause Hard Reset Step 4 "Robot not found" failures.
  //
  // Position / battery comes from robotStates (MQTT socket), looked up by name.
  // A synthetic numeric id (1-based index) is assigned so downstream code that
  // uses FleetRobot.id for ReactFlow node keys continues to work.
  const robots = useMemo<FleetRobot[]>(() => {
    // Fall back to MQTT state keys when GQL hasn't loaded yet so the map still
    // shows any robots that are actively broadcasting.
    const sources: { id: number; name: string }[] =
      gqlRobots && gqlRobots.length > 0
        ? gqlRobots.map((g, i) => ({ id: i + 1, name: g.name }))
        : Object.keys(robotStates).map((key, i) => ({ id: i + 1, name: key }));

    if (sources.length === 0) return [];

    return sources.map(({ id, name }) => {
      // Look up live telemetry by name first, then by synthetic id.
      const liveData = robotStates[name] ?? robotStates[id];
      const activePath = robotPathDetails.get(id);

      return {
        id,
        name,
        status: (liveData?.status ?? 'offline') as FleetRobot['status'],
        battery: liveData?.battery ?? 0,
        x: liveData ? liveData.x * MAP_SCALE : 50,
        y: liveData ? liveData.y * MAP_SCALE : 50 + id * 50,
        currentTask: liveData?.current_task_id
          ? `Task #${liveData.current_task_id}`
          : 'Idle',
        isActive: !!liveData,
        activePath,
      };
    });
  }, [gqlRobots, robotStates, robotPathDetails]);

  // Sync robots into ref so fetchPaths interval reads latest without restarting
  useEffect(() => {
    robotsRef.current = robots;
  }, [robots]);

  // --- UPDATE OVERLAY NODES (robots + trail dots) ---
  useEffect(() => {
    if (robots.length === 0) return;

    // Update trail position history
    robots.forEach((robot) => {
      if (!robot.isActive) return;
      const existing = trailsRef.current.get(robot.name) ?? [];
      const newPos = { x: robot.x, y: robot.y };
      const moved =
        existing.length === 0 ||
        Math.hypot(newPos.x - existing[0].x, newPos.y - existing[0].y) > 8;
      if (moved) {
        trailsRef.current.set(robot.name, [newPos, ...existing].slice(0, MAX_TRAIL_POINTS));
      }
    });

    // Build robot marker nodes
    const robotNodes: Node[] = robots.map((r) => ({
      id: `robot-${r.id}`,
      type: 'robotNode',
      position: { x: r.x, y: r.y },
      data: { label: r.name, status: r.status, battery: r.battery } as RobotNodeData,
      draggable: false,
      zIndex: 100,
    }));

    // Build trail dot nodes (older dots = more transparent)
    const trailNodes: Node[] = [];
    trailsRef.current.forEach((points, robotName) => {
      const ri = robots.findIndex((r) => r.name === robotName);
      if (ri < 0) return;
      const color = VEHICLE_COLORS[ri % VEHICLE_COLORS.length];
      points.forEach((p, i) => {
        trailNodes.push({
          id: `trail-${robotName}-${i}`,
          type: 'trailNode',
          position: p,
          data: { opacity: Math.max(0.07, ((points.length - i) / points.length) * 0.6), color },
          draggable: false,
          selectable: false,
          zIndex: 10 + ri,
        });
      });
    });

    setOverlayNodes([...trailNodes, ...robotNodes]);

    // Build trail edges and inject into overlayEdges (preserve non-trail edges)
    const trailEdges: Edge[] = [];
    trailsRef.current.forEach((points, robotName) => {
      if (points.length < 2) return;
      const ri = robots.findIndex((r) => r.name === robotName);
      if (ri < 0) return;
      const color = VEHICLE_COLORS[ri % VEHICLE_COLORS.length];
      for (let i = 0; i < points.length - 1; i++) {
        const opacity = Math.max(0.04, ((points.length - i - 1) / points.length) * 0.45);
        trailEdges.push({
          id: `trail-edge-${robotName}-${i}`,
          source: `trail-${robotName}-${i + 1}`,
          target: `trail-${robotName}-${i}`,
          type: 'straight',
          animated: false,
          selectable: false,
          style: { stroke: color, strokeWidth: 2, strokeOpacity: opacity },
        });
      }
    });

    setOverlayEdges((prev) => {
      const withoutTrail = prev.filter((e) => !e.id.startsWith('trail-edge-'));
      return [...withoutTrail, ...trailEdges];
    });
  }, [robots]);

  // --- SIMULATION ENGINE: Animate dummy robots along VRP routes ---
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const simStepRef = useRef<number[]>([]); // current step index per vehicle
  const currentSimRoutesRef = useRef<string>(""); // Track currently running simulation to prevent double-starts
  const simPausedRef = useRef(false); // Read inside interval callback without stale-closure issues

  useEffect(() => {
    // Cleanup any existing simulation
    if (simIntervalRef.current) {
      clearInterval(simIntervalRef.current);
      simIntervalRef.current = null;
    }

    if (!simulationRoutes || simulationRoutes.length === 0) {
      // Clear simulation path edges from overlay
      setOverlayEdges((prev) => prev.filter((e) => !e.id.startsWith("sim-path-")));
      setRobotPathDetails(new Map());
      currentSimRoutesRef.current = "";
      return;
    }

    // Wait for nodes to be loaded from the database before spawning robots
    if (!nodesLoaded) return;

    const newSimHash = JSON.stringify(simulationRoutes);
    if (newSimHash === currentSimRoutesRef.current) {
      return; // Already running this simulation
    }
    currentSimRoutesRef.current = newSimHash;

    // Initialize step counters and reset pause state
    simStepRef.current = simulationRoutes.map(() => 0);
    simPausedRef.current = false;
    addLog("[Simulation] Route dispatched - highlighting paths");

    // Build node position map from current static nodes
    const getNodePos = (nodeId: number): { x: number; y: number } | null => {
      return nodePositionsRef.current.get(String(nodeId)) || null;
    };

    // Set initial path details for table (use nodeAliasMapRef from onLoad)
    const initialPathDetails = new Map<number, string[]>();
    simulationRoutes.forEach((route, vi) => {
      const aliases = route.map((nid) => nodeAliasMapRef.current.get(nid) ?? `Node ${nid}`);
      initialPathDetails.set(vi, aliases);
    });
    setRobotPathDetails(initialPathDetails);

    // Highlight all path edges
    const simEdges: Edge[] = [];
    simulationRoutes.forEach((route, vi) => {
      for (let i = 0; i < route.length - 1; i++) {
        const sourceId = route[i];
        const targetId = route[i + 1];
        if (sourceId === undefined || targetId === undefined) continue;
        /**
         * React Flow can error when an edge references a node ID that does not
         * exist in the current graph state. We skip invalid pairs defensively.
         */
        if (!getNodePos(sourceId) || !getNodePos(targetId)) continue;
        simEdges.push({
          id: `sim-path-${vi}-${i}`,
          source: String(sourceId),
          target: String(targetId),
          animated: true,
          style: { stroke: VEHICLE_COLORS[vi % VEHICLE_COLORS.length], strokeWidth: 3 },
          zIndex: 5,
          type: "straight",
        });
      }
    });

    setOverlayEdges((prev) => {
      const withoutSimEdges = prev.filter((e) => !e.id.startsWith("sim-path-"));
      return [...withoutSimEdges, ...simEdges];
    });

    // Defer interval start by one tick so nodePositionsRef is populated
    const startSimulation = () => {
      simIntervalRef.current = setInterval(() => {
        // Pause: skip tick but keep interval alive so resume restarts from same position
        if (simPausedRef.current) return;

        let allDone = true;

        const edgesToDim: string[] = [];
        const logMessages: string[] = [];

        simulationRoutes.forEach((route, vi) => {
          const currentStep = simStepRef.current[vi];
          if (currentStep >= route.length - 1) return; // Vehicle finished

          allDone = false;
          const nextStep = currentStep + 1;
          simStepRef.current[vi] = nextStep;

          const nextNodeId = route[nextStep];
          if (nextNodeId !== undefined) {
            const nodeAlias = nodeAliasMapRef.current.get(nextNodeId) || `Node ${nextNodeId}`;
            if (nextStep % 3 === 0) {
              logMessages.push(`[Route] V${vi + 1} → ${nodeAlias}`);
            }
          }

          // Dim traversed edges
          if (nextStep > 0) {
            edgesToDim.push(`sim-path-${vi}-${currentStep - 1}`);
          }
        });

        if (edgesToDim.length > 0) {
          const dimSet = new Set(edgesToDim);
          setOverlayEdges((prev) =>
            prev.map((e) =>
              dimSet.has(e.id) ? { ...e, animated: false, style: { ...e.style, opacity: 0.3 } } : e
            )
          );
        }
        logMessages.forEach((msg) => addLog(msg));

        if (allDone) {
          addLog("[Simulation] All vehicles have reached their destinations");
          if (simIntervalRef.current) {
            clearInterval(simIntervalRef.current);
            simIntervalRef.current = null;
          }
        }
      }, 1200); // Move every 1.2 seconds
    };

    // Defer by one tick so nodePositionsRef has synced after setNodes calls above
    const startTimeout = setTimeout(startSimulation, 50);

    return () => {
      clearTimeout(startTimeout);
      if (simIntervalRef.current) {
        clearInterval(simIntervalRef.current);
        simIntervalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationRoutes, nodesLoaded]);

  // --- PATH VISUALIZATION & SEQUENCE EXTRACTION ---
  // robots is kept in robotsRef so adding it to deps would restart the interval
  // every 200ms (whenever MQTT state updates). nodesLoaded gates the interval
  // start so it only runs after WarehouseGraph.onLoad has populated the refs.
  useEffect(() => {
    if (!nodesLoaded) return;

    const fetchPaths = async () => {
      const currentRobots = robotsRef.current;
      if (currentRobots.length === 0) return;
      const cellMap = cellMapRef.current;
      const nodeAliasMap = nodeAliasMapRef.current;
      if (cellMap.size === 0 || nodeAliasMap.size === 0) return;

      try {
        const { data: assignments } = await supabase
          .from("wh_assignments")
          .select("id, robot_id")
          .eq("status", "in_progress");

        if (!assignments || assignments.length === 0) {
          setOverlayEdges((prev) => prev.filter((e) => !e.id.startsWith("path-")));
          setRobotPathDetails(new Map());
          return;
        }

        const assignmentIds = assignments.map((a) => a.id);
        const { data: tasks } = await supabase
          .from("wh_tasks")
          .select("*")
          .in("assignment_id", assignmentIds)
          .neq("status", "delivered")
          .order("seq_order");

        if (!tasks) return;

        const pathEdges: Edge[] = [];
        const newPathDetails = new Map<number, string[]>();

        assignments.forEach((asn) => {
          const asnTasks = tasks.filter((t) => t.assignment_id === asn.id);
          if (asnTasks.length === 0) return;

          const bot = currentRobots.find((r) => r.id === asn.robot_id);
          let prevSource = bot ? `robot-${bot.id}` : null;
          let prevSourceHandle = "mobile-source";

          const aliasSequence: string[] = [];

          asnTasks.forEach((task, i) => {
            const targetNodeId = cellMap.get(task.cell_id);
            if (targetNodeId === undefined || targetNodeId === null) return;

            const alias = nodeAliasMap.get(targetNodeId) ?? `Node ${targetNodeId}`;
            aliasSequence.push(alias);

            const targetHandle = targetNodeId.toString();
            if (!nodePositionsRef.current.has(targetHandle)) return;

            if (prevSource) {
              pathEdges.push({
                id: `path-${asn.id}-${i}`,
                source: prevSource,
                sourceHandle: prevSourceHandle,
                target: targetHandle,
                targetHandle: "top-target",
                animated: true,
                style: { stroke: "#22c55e", strokeWidth: 2, strokeDasharray: "5,5" },
                type: 'animatedEdge',
              });
            }
            prevSource = targetHandle;
            prevSourceHandle = "bottom-source";
          });

          if (asn.robot_id) {
            newPathDetails.set(asn.robot_id, aliasSequence);
          }
        });

        setRobotPathDetails(newPathDetails);
        setOverlayEdges((prev) => {
          const nonPath = prev.filter((e) => !e.id.startsWith("path-"));
          return [...nonPath, ...pathEdges];
        });
      } catch (err) {
        console.error("[FleetController] Error fetching paths:", err);
      }
    };

    fetchPaths();
    const interval = setInterval(fetchPaths, PATH_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesLoaded]);

  // --- COMMAND HANDLER (stable callback) ---
  const handleCommand = useCallback(
    (robotId: number, command: string, robotName: string) => {
      console.log(`[FleetController] Sending ${command} to Robot ${robotId}`);
      if (command === "PAUSE") {
        setFleetPaused(true);
        simPausedRef.current = true;
      } else if (command === "RESUME") {
        setFleetPaused(false);
        simPausedRef.current = false;
      } else if (command === "ESTOP" || command === "CANCEL") {
        setFleetPaused(true);
        simPausedRef.current = true;
        cancelAllDispatches();
      }
      publishCommand(robotId, command as "PAUSE" | "RESUME" | "ESTOP" | "CANCEL", { robotName });
    },
    [publishCommand],
  );

  // --- HARD RESET HANDLER ---
  const handleHardReset = useCallback(async (robotName: string) => {
    if (!onHardReset) return;
    // Initialise progress immediately so the stepper appears
    setHardResetStates(prev => {
      const next = new Map(prev);
      next.set(robotName, [
        { stepId: 'cancel_current', label: 'Cancel Current Job',  status: 'pending' },
        { stepId: 'clean_queue',    label: 'Clean Active Queue',  status: 'pending' },
        { stepId: 'clear_error',    label: 'Clear Error State',   status: 'pending' },
        { stepId: 'verify',         label: 'Verify IDLE Status',  status: 'pending' },
      ]);
      return next;
    });

    let finalSteps: HardResetProgress[] = [];
    await onHardReset(robotName, (steps) => {
      finalSteps = steps;
      setHardResetStates(prev => {
        const next = new Map(prev);
        next.set(robotName, steps);
        return next;
      });
    });

    // Log outcome to the System Log panel once the full sequence finishes.
    const allDone   = finalSteps.length > 0 && finalSteps.every(s => s.status === 'done');
    const anyFailed = finalSteps.some(s => s.status === 'failed');
    if (allDone) {
      addLog(`[HardReset] ✓ ${robotName} successfully reset — all 4 steps passed. Robot is IDLE.`);
    } else if (anyFailed) {
      const failedLabels = finalSteps.filter(s => s.status === 'failed').map(s => s.label).join(', ');
      addLog(`[HardReset] ⚠ ${robotName} reset finished with failures: ${failedLabels}`);
    }
  }, [onHardReset, addLog]);

  // --- RENDER ---
  return (
    <div className="w-full h-full relative font-sans">
      <WarehouseGraph
        graphId={graphId}
        overlayNodes={overlayNodes}
        overlayEdges={overlayEdges}
        extraNodeTypes={extraNodeTypes}
        onLoad={handleGraphLoad}
      >
        {/* Header Panel */}
        <Panel position="top-left" className="m-6">
          <div className="bg-white/90 dark:bg-[#121214]/90 backdrop-blur-md border border-gray-200 dark:border-white/10 shadow-xl px-5 py-4 rounded-2xl flex items-center gap-4 text-gray-900 dark:text-white transition-colors">
            <div className="p-2.5 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-500/20 dark:to-indigo-500/10 border border-blue-100 dark:border-white/5 text-blue-600 dark:text-blue-400 rounded-xl shadow-inner">
              <Truck size={22} className="drop-shadow-sm" />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight leading-none bg-clip-text text-transparent bg-gradient-to-r from-gray-800 to-gray-500 dark:from-white dark:to-gray-400">
                Fleet Controller
              </h2>
              <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400 mt-1.5 flex items-center gap-3">
                <ConnectionStatusBadge
                  status={connectionStatus}
                  reconnectAttempts={reconnectAttempts}
                  onReconnect={forceReconnect}
                />
                {simMode && (
                  <span className="px-1.5 py-0.5 bg-amber-500/15 border border-amber-400/30 text-amber-500 text-[9px] font-bold rounded-full uppercase tracking-wider">
                    SIM
                  </span>
                )}
                <span className="text-gray-300 dark:text-gray-700">|</span>
                <span className="flex items-center gap-1.5">
                  <span className="uppercase tracking-wider">Active:</span>
                  <span className="text-gray-900 dark:text-white bg-gray-100 dark:bg-white/10 px-2 py-0.5 rounded-full shadow-sm">
                    {robots.filter((r) => r.isActive).length}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </Panel>

        {/* Auto-fit view when simulation starts */}
        <AutoFitView trigger={!!(simulationRoutes && simulationRoutes.length > 0)} />

        {/* BOTTOM PANEL - ROBOT TABLE & LOGS */}
        <Panel position="bottom-center" className="m-4 w-[95%] max-w-5xl flex gap-4" style={{ pointerEvents: 'none' }}>

          {/* Main Table */}
          <div className="flex-1 bg-white/95 dark:bg-[#121214]/90 backdrop-blur-md border border-gray-200 dark:border-white/10 rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-64 pointer-events-auto">
            <div className="bg-gradient-to-r from-gray-50 to-white dark:from-white/5 dark:to-transparent px-5 py-3 border-b border-gray-100 dark:border-white/5 flex justify-between items-center">
              <h3 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase flex items-center gap-2">
                <Activity size={16} className="text-blue-500" /> Active Fleet Status
              </h3>
            </div>

            <div className="overflow-y-auto flex-1 custom-scrollbar">
              <table className="w-full text-left border-collapse">
                <thead className="bg-gray-50/80 dark:bg-white/5 sticky top-0 z-10 text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider backdrop-blur-sm">
                  <tr>
                    <th className="px-5 py-3 border-b border-gray-100 dark:border-white/5">Identity</th>
                    <th className="px-5 py-3 border-b border-gray-100 dark:border-white/5">Status</th>
                    <th className="px-5 py-3 border-b border-gray-100 dark:border-white/5">Battery</th>
                    <th className="px-5 py-3 border-b border-gray-100 dark:border-white/5">Current Activity & Path</th>
                    <th className="px-5 py-3 border-b border-gray-100 dark:border-white/5 text-right">
                      Controls {onHardReset && <span className="ml-1 text-orange-400 font-normal normal-case">+ Reset</span>}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-white/5">
                  {/* Render Live Robots from DB */}
                  {robots.map((r) => {
                    const gqlRobot = gqlRobots?.find(g => g.name === r.name);
                    const resetSteps = hardResetStates.get(r.name);
                    const isResetting = resetSteps?.some(s => s.status === 'running') ?? false;
                    return (
                      <RobotTableRow
                        key={`live-${r.id}`}
                        robot={r}
                        onCommand={handleCommand}
                        gqlRobot={gqlRobot}
                        onHardReset={onHardReset ? () => handleHardReset(r.name) : undefined}
                        isResetting={isResetting}
                        isActive={r.name === activeRobotName}
                      />
                    );
                  })}

                  {robots.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-gray-500 dark:text-gray-400 text-xs italic opacity-70">
                        No robots detected in fleet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Hard Reset Progress — shown when any reset is active or recently completed */}
            {hardResetStates.size > 0 && (
              <div className="border-t border-gray-100 dark:border-white/5 px-4 py-3 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-[10px] font-bold uppercase text-orange-600 dark:text-orange-400 flex items-center gap-1.5">
                    <RotateCcw size={11} /> Hard Reset Progress
                  </h4>
                  {/* Dismiss button — only when no step is actively running */}
                  {Array.from(hardResetStates.values()).every(steps => steps.every(s => s.status !== 'running')) && (
                    <button
                      onClick={() => setHardResetStates(new Map())}
                      className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
                {Array.from(hardResetStates.entries()).map(([robotName, steps]) => (
                  <div key={robotName} className="space-y-2">
                    <div className="text-[11px] font-bold text-gray-700 dark:text-gray-300">{robotName}</div>
                    {/* Step indicators — horizontal stepper */}
                    <div className="flex items-start gap-1">
                      {steps.map((step, i) => {
                        const Icon =
                          step.status === 'running' ? Loader2 :
                          step.status === 'done'    ? CheckCircle2 :
                          step.status === 'failed'  ? XCircle : Clock;
                        const color =
                          step.status === 'running' ? 'text-blue-500 dark:text-blue-400' :
                          step.status === 'done'    ? 'text-green-600 dark:text-green-400' :
                          step.status === 'failed'  ? 'text-red-500' : 'text-gray-400 dark:text-gray-600';
                        const bg =
                          step.status === 'running' ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/30' :
                          step.status === 'done'    ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30' :
                          step.status === 'failed'  ? 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30' :
                          'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10';
                        return (
                          <React.Fragment key={step.stepId}>
                            <div className={`flex-1 flex flex-col items-center gap-1 p-2 rounded-lg border text-center ${bg}`}>
                              <Icon size={13} className={`${color} ${step.status === 'running' ? 'animate-spin' : ''}`} />
                              <span className={`text-[9px] font-bold leading-tight ${color}`}>{step.label}</span>
                            </div>
                            {i < steps.length - 1 && (
                              <div className={`self-center w-3 h-px shrink-0 ${step.status === 'done' ? 'bg-green-400' : 'bg-gray-200 dark:bg-white/10'}`} />
                            )}
                          </React.Fragment>
                        );
                      })}
                    </div>
                    {/* Detail message for the most recent active/completed step */}
                    {(() => {
                      const active = [...steps].reverse().find(s => s.status !== 'pending' && s.detail);
                      if (!active) return null;
                      return (
                        <p className={`text-[10px] font-mono px-1 break-all ${active.status === 'failed' ? 'text-red-500' : active.status === 'done' ? 'text-green-600 dark:text-green-400' : 'text-blue-500'}`}>
                          {active.detail}
                        </p>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Logs toggle (mobile only) */}
          <button
            onClick={() => setShowLogs(v => !v)}
            className="md:hidden shrink-0 pointer-events-auto self-end px-2 py-1.5 bg-white/90 dark:bg-[#121214]/90 border border-gray-200 dark:border-white/10 rounded-xl shadow-md text-[10px] font-bold text-gray-600 dark:text-gray-300 flex items-center gap-1"
          >
            <Terminal size={12} /> {showLogs ? 'Hide Logs' : 'Show Logs'}
          </button>

          {/* Logs Side Panel */}
          <div className={`w-72 pointer-events-auto ${showLogs ? 'block' : 'hidden md:block'}`}>
            <div className="bg-white/95 dark:bg-[#121214]/90 backdrop-blur-md border border-gray-200 dark:border-white/10 rounded-2xl shadow-xl flex flex-col overflow-hidden h-full max-h-64">
              <div className="bg-gradient-to-r from-gray-50 to-white dark:from-white/5 dark:to-transparent px-4 py-3 border-b border-gray-100 dark:border-white/5 flex justify-between items-center">
                <span className="text-[10px] font-bold text-gray-700 dark:text-gray-300 uppercase flex items-center gap-1.5">
                  <Terminal size={14} className="text-gray-400" /> System Logs
                </span>
                <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse" />
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-1 custom-scrollbar">
                {logs.length === 0 && (
                  <div className="text-[10px] text-gray-500 dark:text-gray-500/70 italic text-center py-4">
                    Waiting for events...
                  </div>
                )}
                {logs.map((log, i) => {
                  // Classify log by its bracketed prefix (e.g. [ERROR], [HardReset], [Simulation]).
                  const isError   = /\[error\]|\[estop\]|✗|\bfail/i.test(log);
                  const isSuccess = /✓|successfully|success|reset.*passed|IDLE/i.test(log);
                  const isWarn    = /⚠|warn|OPERATING|offline/i.test(log);
                  const isSim     = /\[sim\]/i.test(log);

                  const dot = isError   ? 'bg-red-500'
                            : isSuccess ? 'bg-green-500'
                            : isWarn    ? 'bg-amber-400'
                            : isSim     ? 'bg-amber-500'
                            : 'bg-blue-400';

                  const text = isError   ? 'text-red-500 dark:text-red-400'
                             : isSuccess ? 'text-green-700 dark:text-green-400'
                             : isWarn    ? 'text-amber-600 dark:text-amber-400'
                             : isSim     ? 'text-amber-600 dark:text-amber-400'
                             : 'text-gray-600 dark:text-gray-400';

                  return (
                    <div
                      key={i}
                      className={`flex items-start gap-1.5 text-[10px] font-mono border-b border-gray-50 dark:border-white/5 last:border-0 pb-1 break-words ${text}`}
                    >
                      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                      <span>{log}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

        </Panel>

      </WarehouseGraph>
    </div>
  );
};

export default FleetController;
