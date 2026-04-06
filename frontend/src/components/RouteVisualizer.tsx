/**
 * @file RouteVisualizer.tsx
 * @description Modal and inline warehouse graph visualizer for VRP solutions.
 *
 * Renders the warehouse layout using the same `useGraphData.loadGraph()` pipeline
 * as the Graph Editor, ensuring visual consistency across all tabs (nodes,
 * background image, shelf grid, edge styles all match exactly).
 *
 * Solution overlay:
 *   - Base edges that lie along a solved route are animated and coloured by vehicle.
 *   - Edges that appear in the solution but not in the base graph are rendered as
 *     dashed "virtual" edges so the user can always see the intended path.
 *   - When no solution is active the raw base graph is shown as a live preview.
 */

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  MarkerType,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  type NodeProps,
} from 'reactflow';
import { X, Map as MapIcon, Loader2, CheckSquare } from 'lucide-react';
import 'reactflow/dist/style.css';

import { useThemeStore } from '../store/themeStore';
import { useGraphData } from '../hooks/useGraphData';
import WaypointNode from './nodes/WaypointNode';
import ShelfNode from './nodes/ShelfNode';
import AnimatedEdge from './edges/AnimatedEdge';

// ============================================================
// TYPES
// ============================================================

interface SolverRoute {
  vehicle_id: number;
  steps?: { node_id: number; [key: string]: any }[];
  nodes?: number[];
  distance: number;
}

export interface PathSegment {
  edge_id: number;
  distance: number;
}

export interface SolverSolution {
  feasible: boolean;
  total_distance: number;
  wall_time_ms: number;
  routes: SolverRoute[];
  summary: string;
}

interface RouteVisualizerProps {
  /**
   * ID of the warehouse graph to display.
   * The component calls `useGraphData(graphId).loadGraph()` internally so the
   * canvas always matches the Graph Editor view.
   */
  graphId: number;
  isOpen: boolean;
  onClose: () => void;
  solution: SolverSolution | null;
  /** Called with the DB node ID when the user clicks a node (simulation mode). */
  onNodeClick?: (nodeId: number) => void;
  title?: string;
  instruction?: string;
  /** When true the component renders inline (no modal overlay). */
  inline?: boolean;
}

// ============================================================
// COLOUR PALETTE — one colour per vehicle route
// ============================================================

const VEHICLE_COLORS = [
  '#2563eb', // blue
  '#dc2626', // red
  '#16a34a', // green
  '#9333ea', // purple
  '#ea580c', // orange
  '#0891b2', // cyan
];

// ============================================================
// READ-ONLY MAP BACKGROUND NODE
// ============================================================

/**
 * Renders the warehouse floor-plan image stored in wh_graphs.map_url.
 * Identical to the read-only MapNode in WarehouseGraph.tsx.
 */
const MapNode = ({ data }: NodeProps) => (
  <img
    src={data.url}
    alt="Map Background"
    style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
    draggable={false}
  />
);

// ============================================================
// NODE / EDGE TYPE REGISTRIES
// ============================================================

/** Stable reference — defined outside the component to avoid re-registration. */
const NODE_TYPES: NodeTypes = {
  waypointNode: WaypointNode,
  shelfNode:    ShelfNode,
  mapNode:      MapNode,
};

const EDGE_TYPES = { animatedEdge: AnimatedEdge };

// ============================================================
// COMPONENT
// ============================================================

const RouteVisualizer: React.FC<RouteVisualizerProps> = ({
  graphId,
  isOpen,
  onClose,
  solution,
  onNodeClick,
  title = 'Route Visualization',
  instruction,
  inline = false,
}) => {
  const { theme }     = useThemeStore();
  const { loadGraph } = useGraphData(graphId);

  // ── Base graph (loaded from Supabase — same pipeline as Graph Editor) ──────
  const [baseNodes, setBaseNodes] = useState<Node[]>([]);
  const [baseEdges, setBaseEdges] = useState<Edge[]>([]);
  const [graphLoading, setGraphLoading] = useState(false);

  /**
   * Load the base graph whenever the component becomes visible.
   * Uses a `cancelled` flag to discard stale results on fast open/close cycles.
   */
  useEffect(() => {
    if (!graphId || (!isOpen && !inline)) return;

    let cancelled = false;
    setGraphLoading(true);

    loadGraph().then((result) => {
      if (cancelled) return;
      setBaseNodes(result.nodes);
      setBaseEdges(result.edges);
      setGraphLoading(false);
    });

    return () => { cancelled = true; };
  }, [graphId, isOpen, inline, loadGraph]);

  // ── Solution edge overlay ─────────────────────────────────────────────────

  /**
   * Derives the display edge set from the base graph + active solution.
   *
   * Logic:
   *   1. For each route, iterate consecutive step pairs (A → B).
   *   2. If a base edge connects A and B, mark it animated with the vehicle colour.
   *   3. If no base edge exists for that step, create a dashed virtual edge so
   *      the path is always visible even in disconnected graph states.
   *   4. All base edges NOT on any route path are dimmed (grey, 40 % opacity).
   *   5. When no solution is active, return the base edges unchanged.
   */
  const displayEdges = useMemo<Edge[]>(() => {
    if (!solution?.routes?.length) return baseEdges;

    // Map each active base-edge ID to the vehicle colour that traverses it.
    const activeEdgeColor = new Map<string, string>();
    const virtualEdges: Edge[] = [];

    solution.routes.forEach((route, routeIdx) => {
      const steps = route.steps ?? [];
      const color = VEHICLE_COLORS[routeIdx % VEHICLE_COLORS.length];

      for (let i = 0; i < steps.length - 1; i++) {
        const srcId = String(steps[i].node_id);
        const tgtId = String(steps[i + 1].node_id);

        // Locate the matching base edge (edges are bidirectional in the DB).
        const matchedEdge = baseEdges.find(
          (e) =>
            (e.source === srcId && e.target === tgtId) ||
            (e.source === tgtId && e.target === srcId),
        );

        if (matchedEdge) {
          // Prefer a more prominent colour if multiple routes share an edge.
          activeEdgeColor.set(matchedEdge.id, color);
        } else {
          // The solver produced a step that skips intermediate nodes.
          // Show it as a dashed virtual edge so the user can still follow the path.
          virtualEdges.push({
            id: `virtual-${routeIdx}-${i}-${srcId}-${tgtId}`,
            source: srcId,
            target: tgtId,
            animated: true,
            type: 'animatedEdge',
            style: {
              stroke: color,
              strokeWidth: 4,
              strokeDasharray: '10 5',
            },
            markerEnd: { type: MarkerType.ArrowClosed, color },
            zIndex: 10,
          });
        }
      }
    });

    // Restyle base edges: highlight active ones, dim inactive ones.
    const styledBase = baseEdges.map((e) => {
      const color = activeEdgeColor.get(e.id);
      if (color) {
        return {
          ...e,
          animated: true,
          style: { stroke: color, strokeWidth: 4 },
          zIndex: 10,
        };
      }
      return {
        ...e,
        animated: false,
        style: { stroke: '#94a3b8', strokeWidth: 1, opacity: 0.4 },
        zIndex: 0,
      };
    });

    return [...styledBase, ...virtualEdges];
  }, [solution, baseEdges]);

  // ── Node display array (inject onCellClick into shelf nodes) ────────────

  /**
   * When the visualizer is in node-selection mode (`onNodeClick` is set),
   * inject `onCellClick` into each ShelfNode's data so that clicking an
   * individual cell div calls `onNodeClick(cellId)` directly.
   * Cell nodes are hidden in the base graph (rendered inside ShelfNode),
   * so this is the only way to select them from the map.
   */
  const displayNodes = useMemo<Node[]>(() => {
    if (!onNodeClick) return baseNodes;
    return baseNodes.map((n) => {
      if (n.type === 'shelfNode') {
        return { ...n, data: { ...n.data, onCellClick: onNodeClick } };
      }
      return n;
    });
  }, [baseNodes, onNodeClick]);

  // ── Node click handler (for waypointNode / depot / conveyor) ─────────────

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!onNodeClick || node.id === 'map-background') return;
      // ShelfNode cell clicks are handled by onCellClick above;
      // clicking the shelf body itself selects the shelf node.
      const numericId = parseInt(node.id, 10);
      if (!isNaN(numericId)) onNodeClick(numericId);
    },
    [onNodeClick],
  );

  // ── Shared canvas ─────────────────────────────────────────────────────────

  const canvas = (
    <ReactFlow
      nodes={displayNodes}
      edges={displayEdges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodeClick={onNodeClick ? handleNodeClick : undefined}
      fitView
      minZoom={0.05}
      maxZoom={4}
      panOnScroll
      panOnDrag
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={!!onNodeClick}
      defaultEdgeOptions={{ type: 'animatedEdge' }}
    >
      <Background
        color={theme === 'dark' ? '#1e293b' : '#cbd5e1'}
        gap={20}
        size={1}
        variant={BackgroundVariant.Dots}
      />
      <Controls />
    </ReactFlow>
  );

  // ── Early return guards ───────────────────────────────────────────────────

  if (!isOpen && !inline) return null;

  // ── Inline mode ───────────────────────────────────────────────────────────

  if (inline) {
    return (
      <div className="flex-1 w-full h-full bg-[#f8fafc] dark:bg-[#09090b] relative z-0">
        {graphLoading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        )}

        {canvas}

        {!solution && baseNodes.length > 0 && (
          <div className="absolute top-4 right-4 bg-white/90 dark:bg-[#121214]/90 backdrop-blur-sm border border-gray-200 dark:border-white/10 px-3 py-1.5 rounded-lg shadow-sm text-[10px] font-bold text-gray-500 dark:text-gray-400 pointer-events-none z-10 flex items-center gap-2">
            <MapIcon size={12} className="text-blue-500" />
            LIVE GRAPH PREVIEW
          </div>
        )}
      </div>
    );
  }

  // ── Modal mode ────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 backdrop-blur-sm p-4 sm:p-8">
      <div className="bg-white dark:bg-[#121214] w-full h-full max-w-6xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="h-16 border-b border-gray-100 dark:border-white/5 flex items-center justify-between px-6 bg-gray-100 dark:bg-white/5">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 text-white p-2 rounded-lg shadow-lg shadow-blue-200">
              <MapIcon size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900 dark:text-white">{title}</h2>
              <div className="flex items-center gap-2">
                <span className="text-[10px] bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded font-mono uppercase">
                  {solution ? solution.summary : 'Preview Mode'}
                </span>
                {graphLoading && (
                  <span className="flex items-center gap-1 text-[10px] text-blue-600 font-bold animate-pulse">
                    <Loader2 size={10} className="animate-spin" /> LOADING...
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-200 dark:bg-white/10 rounded-full transition-colors"
          >
            <X size={20} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {/* Canvas */}
        <div className="flex-1 bg-gray-100 dark:bg-white/5 relative">
          {canvas}

          {/* Legend */}
          <div className="absolute bottom-4 left-4 flex flex-col gap-2 pointer-events-none">
            <div className="bg-white dark:bg-[#121214]/90 backdrop-blur-sm p-3 rounded-xl shadow-sm border border-gray-200 dark:border-white/10 text-[10px] space-y-2">
              <p className="font-bold text-gray-900 dark:text-white uppercase tracking-tight">Legend</p>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-600 border border-white" />
                <span className="text-gray-600 dark:text-gray-400">Interactive Node</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-1 bg-blue-600" />
                <span className="text-gray-600 dark:text-gray-400">Assigned Path</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-px border-b border-blue-600 border-dashed" />
                <span className="text-gray-600 dark:text-gray-400">Virtual Segment</span>
              </div>
            </div>

            {instruction ? (
              <div className="bg-blue-600 text-white px-4 py-2 rounded-xl shadow-lg text-xs font-bold">
                {instruction}
              </div>
            ) : onNodeClick ? (
              <div className="bg-blue-600 text-white px-4 py-2 rounded-xl shadow-lg text-xs font-bold">
                Click any node to preview route
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className="h-16 border-t border-gray-100 dark:border-white/5 flex items-center justify-between px-6 bg-white dark:bg-[#121214] gap-3">
          <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
            <CheckSquare size={14} className="text-gray-300 dark:text-gray-600" />
            <span>
              {onNodeClick ? 'Showing live simulation path' : 'Reviewing optimized fleet solution'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="px-6 py-2 bg-gray-800 dark:bg-blue-600 text-white text-sm font-bold rounded-xl hover:bg-gray-700 dark:hover:bg-blue-500 hover:shadow-lg transition-all active:scale-95"
          >
            DONE {onNodeClick ? 'SIMULATING' : 'REVIEWING'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RouteVisualizer;
