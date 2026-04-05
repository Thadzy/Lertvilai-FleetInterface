/**
 * WarehouseGraph — Reusable, self-loading warehouse graph canvas.
 * ═══════════════════════════════════════════════════════════════
 *
 * This component encapsulates the complete ReactFlow canvas for displaying a
 * warehouse layout.  It is **self-contained**: it fetches the base graph from
 * Supabase on mount and manages its own `baseNodes` / `baseEdges` state.
 *
 * Parents inject dynamic overlays (robot markers, path highlights, simulation
 * routes) through props rather than owning the ReactFlow state directly.  This
 * eliminates the duplicated graph-loading code that previously existed in both
 * FleetController and GraphEditor.
 *
 * ─── Overlay pattern ───────────────────────────────────────────────────────
 *
 *   displayed nodes = [...baseNodes,  ...overlayNodes]
 *   displayed edges = [...baseEdges*, ...overlayEdges]
 *
 *   * baseEdges are styled by the visualizedPath prop when a path is active.
 *
 * ─── Getting base data out ──────────────────────────────────────────────────
 *
 *   Use the `onLoad` callback to receive `nodeAliasMap`, `cellMap`, and
 *   `nodePositions` so that parent-level simulation / path logic can look up
 *   node coordinates without duplicating the Supabase query.
 *
 * @module WarehouseGraph
 */

import React, {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  BackgroundVariant,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { useThemeStore } from '../store/themeStore';
import { useGraphData, type Level } from '../hooks/useGraphData';
import WaypointNode from './nodes/WaypointNode';
import ShelfNode from './nodes/ShelfNode';
import AnimatedEdge from './edges/AnimatedEdge';

// ──────────────────────────────────────────────────────────────────────────────
// Built-in node / edge types
// ──────────────────────────────────────────────────────────────────────────────

/** Node types always available inside WarehouseGraph. */
const BASE_NODE_TYPES: NodeTypes = {
  waypointNode: WaypointNode,
  shelfNode: ShelfNode,
};

/** Edge types always available inside WarehouseGraph. */
const BASE_EDGE_TYPES = {
  animatedEdge: AnimatedEdge,
};

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot delivered to `onLoad` after the base graph has been fetched.
 * Store these in refs inside the parent to avoid closure-staleness issues.
 */
export interface WarehouseGraphOnLoadPayload {
  /** ReactFlow `Node[]` for the warehouse base layout (shelf nodes, waypoints, …). */
  baseNodes: Node[];
  /** ReactFlow `Edge[]` connecting the base layout nodes. */
  baseEdges: Edge[];
  /** Canvas position of each base node keyed by its string ID. */
  nodePositions: Map<string, { x: number; y: number }>;
  /** Maps `wh_nodes.id` → alias string (e.g. `4 → "W3"`). */
  nodeAliasMap: Map<number, string>;
  /**
   * Maps `wh_cells.id` → `wh_nodes.id`.
   * Use this to resolve `task.cell_id` → graph-node position for path drawing.
   */
  cellMap: Map<number, number>;
  /** Level list for this graph (for level-filter UI). */
  levels: Level[];
}

/** Props for `<WarehouseGraph />`. */
export interface WarehouseGraphProps {
  /** Primary key of the graph row in `wh_graphs`. */
  graphId: number;

  /**
   * Nodes to layer on top of the base graph.
   * Typical contents: robot markers, trail dots, debug pins.
   * The array reference should be stable (useMemo / useState) to avoid
   * unnecessary re-renders of the ReactFlow canvas.
   */
  overlayNodes?: Node[];

  /**
   * Edges to layer on top of the base graph.
   * Typical contents: active-path highlights, trail edges, simulation paths.
   */
  overlayEdges?: Edge[];

  /**
   * Ordered sequence of node aliases describing a route to highlight.
   * When set, matching base-graph edges become animated + green; all others
   * are dimmed to 50 % opacity.  Clear by passing `undefined` or `[]`.
   */
  visualizedPath?: string[];

  /**
   * Invoked once per `graphId` after the base graph has been fetched.
   * Capture `nodeAliasMap`, `cellMap`, and `nodePositions` in refs inside the
   * parent so downstream logic (simulation, path queries) can read them without
   * restarting intervals.
   */
  onLoad?: (payload: WarehouseGraphOnLoadPayload) => void;

  /**
   * Additional ReactFlow node-type components to register.
   * Merged with the built-in `waypointNode` and `shelfNode` types.
   * Example: `{ robotNode: RobotNode, trailNode: TrailNode }`.
   */
  extraNodeTypes?: NodeTypes;

  /**
   * Additional ReactFlow edge-type components to register.
   * Merged with the built-in `animatedEdge` type.
   */
  extraEdgeTypes?: Record<string, React.ComponentType<any>>;

  /**
   * React children rendered **inside** the `<ReactFlow>` provider.
   * Use this for `<Panel>` components or any hook-consuming components that
   * require access to `useReactFlow()` (e.g. `<AutoFitView>`, HUD panels).
   */
  children?: React.ReactNode;

  /** Additional Tailwind / CSS class names for the outer wrapper div. */
  className?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Self-contained warehouse graph canvas.
 *
 * Loads the base graph once on mount (or when `graphId` changes), then accepts
 * incremental overlay nodes and edges from the parent for live robot/path data.
 */
const WarehouseGraph: React.FC<WarehouseGraphProps> = ({
  graphId,
  overlayNodes = [],
  overlayEdges = [],
  visualizedPath,
  onLoad,
  extraNodeTypes,
  extraEdgeTypes,
  children,
  className,
}) => {
  const { theme } = useThemeStore();
  const { loadGraph } = useGraphData(graphId);

  // ── Base graph state (loaded from Supabase) ────────────────────────────────
  const [baseNodes, setBaseNodes] = useState<Node[]>([]);
  const [baseEdges, setBaseEdges] = useState<Edge[]>([]);

  // Keep onLoad in a ref so the load effect does not need it as a dependency
  // (prevents re-fetching whenever the parent re-renders with a new callback).
  const onLoadRef = useRef<WarehouseGraphProps['onLoad']>(onLoad);
  onLoadRef.current = onLoad;

  // Track whether onLoad has been called for the current graphId to prevent
  // duplicate invocations caused by React Strict Mode double-mount.
  const onLoadFiredRef = useRef(false);

  // ── Merged node / edge type registries ────────────────────────────────────

  /** Merged node types (base + parent extras). Stable unless extraNodeTypes changes. */
  const nodeTypes = useMemo<NodeTypes>(
    () => ({ ...BASE_NODE_TYPES, ...extraNodeTypes }),
    [extraNodeTypes],
  );

  /** Merged edge types (base + parent extras). Stable unless extraEdgeTypes changes. */
  const edgeTypes = useMemo(
    () => ({ ...BASE_EDGE_TYPES, ...extraEdgeTypes }),
    [extraEdgeTypes],
  );

  // ── Graph loading ──────────────────────────────────────────────────────────

  /**
   * Fetch the base graph once per graphId.
   * Uses a `cancelled` flag to discard stale async results if the component
   * unmounts or `graphId` changes before the request completes.
   */
  useEffect(() => {
    let cancelled = false;
    onLoadFiredRef.current = false;

    loadGraph().then((result) => {
      if (cancelled) return;

      setBaseNodes(result.nodes);
      setBaseEdges(result.edges);

      // Build canvas-position lookup for downstream path/simulation logic.
      const nodePositions = new Map<string, { x: number; y: number }>();
      result.nodes.forEach((n) => {
        if (n.id !== 'map-background') {
          nodePositions.set(n.id, { x: n.position.x, y: n.position.y });
        }
      });

      if (!onLoadFiredRef.current) {
        onLoadFiredRef.current = true;
        onLoadRef.current?.({
          baseNodes: result.nodes,
          baseEdges: result.edges,
          nodePositions,
          nodeAliasMap: result.nodeAliasMap,
          cellMap: result.cellMap,
          levels: result.levels,
        });
      }
    });

    return () => {
      cancelled = true;
    };
    // loadGraph is stable per graphId (useCallback([graphId]) inside useGraphData).
  }, [loadGraph]);

  // ── Path visualisation ─────────────────────────────────────────────────────

  /**
   * Derive styled base edges from the `visualizedPath` prop.
   * Path-matching edges → animated green, all others → dimmed grey.
   * When no path is active the base edges are returned unchanged.
   *
   * This is a pure derivation (useMemo) so `baseEdges` is never mutated.
   */
  const styledBaseEdges = useMemo<Edge[]>(() => {
    if (!visualizedPath || visualizedPath.length < 2) return baseEdges;

    // Build alias → node-id lookup from the current base nodes.
    const aliasToId = new Map<string, string>();
    baseNodes.forEach((n) => {
      if (n.data?.label) aliasToId.set(n.data.label as string, n.id);
    });

    // Identify edge IDs that lie along the visualized path.
    const pathEdgeIds = new Set<string>();
    for (let i = 0; i < visualizedPath.length - 1; i++) {
      const srcId = aliasToId.get(visualizedPath[i]);
      const tgtId = aliasToId.get(visualizedPath[i + 1]);
      if (!srcId || !tgtId) continue;
      const edge = baseEdges.find(
        (e) =>
          (e.source === srcId && e.target === tgtId) ||
          (e.source === tgtId && e.target === srcId),
      );
      if (edge) pathEdgeIds.add(edge.id);
    }

    return baseEdges.map((e) =>
      pathEdgeIds.has(e.id)
        ? {
            ...e,
            type: 'animatedEdge',
            animated: true,
            style: { stroke: '#22c55e', strokeWidth: 4 },
            zIndex: 10,
          }
        : {
            ...e,
            type: 'animatedEdge',
            animated: false,
            style: { stroke: '#94a3b8', strokeWidth: 1, opacity: 0.5 },
            zIndex: 0,
          },
    );
  }, [visualizedPath, baseEdges, baseNodes]);

  // ── Display arrays (base + overlays) ──────────────────────────────────────

  const displayNodes = useMemo(
    () => [...baseNodes, ...overlayNodes],
    [baseNodes, overlayNodes],
  );

  const displayEdges = useMemo(
    () => [...styledBaseEdges, ...overlayEdges],
    [styledBaseEdges, overlayEdges],
  );

  // ── MiniMap node colour helper ─────────────────────────────────────────────

  const miniMapNodeColor = useCallback((n: Node): string => {
    if (n.type === 'robotNode') return '#ef4444';
    const t = n.data?.type as string | undefined;
    if (t === 'shelf') return '#0891b2';
    if (t === 'depot') return '#ef4444';
    if (t === 'conveyor') return '#f59e0b';
    return '#94a3b8';
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className={`w-full h-full bg-gray-50 dark:bg-[#09090b] text-gray-900 dark:text-white transition-colors ${
        className ?? ''
      }`}
    >
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.05}
        maxZoom={4}
        panOnScroll
        panOnDrag
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        defaultEdgeOptions={{ type: 'animatedEdge' }}
      >
        <Background
          color={theme === 'dark' ? '#1e293b' : '#cbd5e1'}
          gap={20}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        <Controls className="!bg-white !border-gray-200 dark:border-white/10 !text-slate-600 !fill-slate-600 shadow-lg" />
        <MiniMap
          className="!bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg shadow-lg"
          nodeColor={miniMapNodeColor}
        />

        {/* Parent-injected Panel / hook-consuming children (useReactFlow safe) */}
        {children}
      </ReactFlow>
    </div>
  );
};

export default WarehouseGraph;
