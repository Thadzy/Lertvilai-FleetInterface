import React, { useEffect, useState, useMemo } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge
} from 'reactflow';
import { X, Map as MapIcon, Loader2, CheckSquare } from 'lucide-react';
import 'reactflow/dist/style.css';
import { type DBNode, type DBEdge } from '../types/database';
import WaypointNode from './nodes/WaypointNode';
import { useThemeStore } from '../store/themeStore';


// --- TYPE DEFINITIONS ---

interface SolverRoute {
  vehicle_id: number;
  steps?: any[];
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
  isOpen: boolean;
  onClose: () => void;
  solution: SolverSolution | null;
  dbNodes: DBNode[];
  dbEdges: DBEdge[];
  onNodeClick?: (nodeId: number) => void;
  title?: string;
  instruction?: string;
  inline?: boolean;
  map_url?: string | null;
}

const RouteVisualizer: React.FC<RouteVisualizerProps> = ({
  isOpen,
  onClose,
  solution,
  dbNodes,
  dbEdges,
  onNodeClick,
  title = "Route Visualization",
  instruction,
  inline = false,
  map_url
}) => {
  const { theme } = useThemeStore();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);

  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isPathProcessing, setIsPathProcessing] = useState(false);

  const handleNodeClick = (_: React.MouseEvent, node: Node) => {
    if (onNodeClick && !isPathProcessing) {
      setIsPathProcessing(true);
      onNodeClick(parseInt(node.id));
      // Reset processing after a short delay since simulatePath is async but state update is fast
      setTimeout(() => setIsPathProcessing(false), 500);
    }
  };

  const nodeTypes = useMemo(() => ({ waypointNode: WaypointNode }), []);

  useEffect(() => {
    if ((!isOpen && !inline) || !dbNodes) return;

    // 1. SETUP NODES
    const scale = 100;

    // Pre-calculate shelf positions and cell counts for fanning logic
    const shelfPositions = new Map<number, { x: number; y: number }>();
    const cellsByShelf = new Map<number, number>();
    const cellIndexByShelf = new Map<number, number>();

    dbNodes.forEach(n => {
      if (n.type === 'shelf') {
        shelfPositions.set(n.id, { x: n.x, y: n.y });
      }
      if (n.type === 'cell' && (n as any).shelf_id != null) {
        const sid = (n as any).shelf_id;
        cellsByShelf.set(sid, (cellsByShelf.get(sid) || 0) + 1);
      }
    });

    const flowNodes: Node[] = dbNodes.map(n => {
      let posX = n.x * scale;
      let posY = n.y * scale;

      // Fanning logic for cells (mirroring useGraphData.ts)
      if (n.type === 'cell' && (n as any).shelf_id != null) {
        const sid = (n as any).shelf_id;
        const shelfPos = shelfPositions.get(sid);
        if (shelfPos) {
          const cellIdx = cellIndexByShelf.get(sid) || 0;
          cellIndexByShelf.set(sid, cellIdx + 1);
          const totalCells = cellsByShelf.get(sid) || 1;
          
          // Arc math: arrange cells in a small arc below their shelf
          const angle = -Math.PI / 2 + (cellIdx * Math.PI / 4) - ((totalCells - 1) * Math.PI / 8);
          const radius = 50; // px offset from shelf center
          posX = shelfPos.x * scale + Math.cos(angle) * radius;
          posY = shelfPos.y * scale + Math.sin(angle) * radius + 40;
        }
      }

      return {
        id: String(n.id), // Stringify for ReactFlow
        type: 'waypointNode',
        position: { x: posX, y: posY },
        data: {
          label: n.alias || String(n.id),
          type: n.type,
          levelAlias: n.level_alias || (n as any).levelAlias || null
        },
        draggable: false,
        style: {
          zIndex: 10
        }
      };
    });

    if (map_url) {
      let mapX = 0, mapY = 0, mapW = 1200, mapH = 800;
      let cleanUrl = map_url;

      if (map_url.includes('#')) {
        const [base, hash] = map_url.split('#');
        cleanUrl = base;
        const params = new URLSearchParams(hash);
        if (params.has('x')) mapX = parseFloat(params.get('x') || '0');
        if (params.has('y')) mapY = parseFloat(params.get('y') || '0');
        if (params.has('w')) mapW = parseFloat(params.get('w') || '1200');
        if (params.has('h')) mapH = parseFloat(params.get('h') || '800');
      }

      flowNodes.unshift({
        id: "map-bg",
        type: "default",
        position: { x: mapX, y: mapY },
        data: { label: null },
        style: {
          width: mapW,
          height: mapH,
          backgroundImage: `url('${cleanUrl}')`,
          backgroundSize: "contain",
          zIndex: -11,
          pointerEvents: 'none',
          backgroundColor: 'transparent',
          border: 'none',
        },
        draggable: false,
        selectable: false,
      });
    }

    // 2. SETUP EDGES & PATH HIGHLIGHTING
    let activeEdgePairs = new Set<string>();
    let virtualEdges: Edge[] = [];

    if (solution && solution.routes && solution.routes.length > 0) {
      // Color palette for multiple vehicles
      const vehicleColors = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

      solution.routes.forEach((route, routeIdx) => {
        const routeSteps = route.steps || [];
        const color = vehicleColors[routeIdx % vehicleColors.length];

        console.log(`[RouteViz] Vehicle ${routeIdx + 1}: ${routeSteps.length} steps (color: ${color})`);

        if (routeSteps.length > 0) {
          for (let i = 0; i < routeSteps.length - 1; i++) {
            const u = String(routeSteps[i].node_id);
            const v = String(routeSteps[i + 1].node_id);

            activeEdgePairs.add(`${u}-${v}`);
            activeEdgePairs.add(`${v}-${u}`);

            // Check if this edge exists in the DB edges
            const existsInDB = dbEdges.some(e =>
              (String(e.node_a_id) === u && String(e.node_b_id) === v) ||
              (String(e.node_a_id) === v && String(e.node_b_id) === u)
            );

            // If it DOESN'T exist in DB, create a virtual path edge so the user still sees it!
            if (!existsInDB) {
              console.warn(`[RouteViz] Virtual segment created: ${u} -> ${v}`);
              virtualEdges.push({
                id: `virtual-${routeIdx}-${u}-${v}`,
                source: u,
                target: v,
                animated: true,
                style: { stroke: color, strokeWidth: 5, strokeDasharray: '10 5' },
                markerEnd: { type: MarkerType.ArrowClosed, color },
                type: 'straight'
              });
            }
          }
        }
      });
    }

    // Map DB Edges
    const flowEdges: Edge[] = dbEdges.map(e => {
      const u = String(e.node_a_id);
      const v = String(e.node_b_id);
      const isActive = activeEdgePairs.has(`${u}-${v}`) || activeEdgePairs.has(`${v}-${u}`);

      return {
        id: `e${u}-${v}`,
        source: u,
        target: v,
        animated: true,
        style: {
          stroke: isActive ? '#2563eb' : '#3b82f6',
          strokeWidth: isActive ? 5 : 2,
          strokeDasharray: isActive ? undefined : '5,5',
          opacity: isActive ? 1 : 0.6
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isActive ? '#2563eb' : '#3b82f6'
        },
        type: 'straight'
      };
    });

    setNodes(flowNodes);
    setEdges([...flowEdges, ...virtualEdges]);

  }, [isOpen, inline, dbNodes, dbEdges, onNodeClick, map_url]);

  if (!isOpen && !inline) return null;

  if (inline) {
    return (
      <div className="flex-1 w-full h-full bg-[#f8fafc] dark:bg-[#09090b] relative z-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          fitView
          minZoom={0.05}
          maxZoom={4}
          panOnScroll
          panOnDrag
          defaultEdgeOptions={{ type: 'straight' }}
        >
          <Background color={theme === "dark" ? "#1e293b" : "#cbd5e1"} gap={20} size={1} variant={BackgroundVariant.Dots} />
        </ReactFlow>
        
        {/* Helper Badge */}
        {!solution && dbNodes.length > 0 && (
          <div className="absolute top-4 right-4 bg-white/90 dark:bg-[#121214]/90 backdrop-blur-sm border border-gray-200 dark:border-white/10 px-3 py-1.5 rounded-lg shadow-sm text-[10px] font-bold text-gray-500 dark:text-gray-400 pointer-events-none z-10 flex items-center gap-2">
            <MapIcon size={12} className="text-blue-500" />
            LIVE GRAPH PREVIEW
          </div>
        )}
      </div>
    );
  }

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
                {isPathProcessing && (
                  <span className="flex items-center gap-1 text-[10px] text-blue-600 font-bold animate-pulse">
                    <Loader2 size={10} className="animate-spin" /> CALCULATING...
                  </span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 dark:bg-white/10 rounded-full transition-colors">
            <X size={20} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {/* Map Canvas */}
        <div className="flex-1 bg-gray-100 dark:bg-white/5 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            fitView
            minZoom={0.05}
            defaultEdgeOptions={{ type: 'straight' }}
          >
            <Background color={theme === "dark" ? "#1e293b" : "#cbd5e1"} gap={20} size={1} variant={BackgroundVariant.Dots} />

            {/* Legend & Instructions */}
            <div className="absolute bottom-4 left-4 flex flex-col gap-2">
              <div className="bg-white dark:bg-[#121214]/90 backdrop-blur-sm p-3 rounded-xl shadow-sm border border-gray-200 dark:border-white/10 text-[10px] space-y-2 pointer-events-none">
                <p className="font-bold text-gray-900 dark:text-white uppercase tracking-tight">Legend</p>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-blue-600 border border-white"></div> <span>Interactive Node</span></div>
                <div className="flex items-center gap-2"><div className="w-6 h-1 bg-blue-600"></div> <span>Assigned Path</span></div>
                <div className="flex items-center gap-2"><div className="w-6 h-1 border-b border-blue-600 border-dashed"></div> <span>Virtual Segment</span></div>
              </div>

              {instruction ? (
                <div className="bg-blue-600 text-white px-4 py-2 rounded-xl shadow-lg text-xs font-bold animate-bounce pointer-events-none">
                  👉 {instruction}
                </div>
              ) : onNodeClick && (
                <div className="bg-blue-600 text-white px-4 py-2 rounded-xl shadow-lg text-xs font-bold animate-bounce pointer-events-none">
                  👉 Click any blue node to preview route
                </div>
              )}
            </div>
          </ReactFlow>
        </div>

        {/* Footer */}
        <div className="h-16 border-t border-gray-100 dark:border-white/5 flex items-center justify-between px-6 bg-white dark:bg-[#121214] gap-3">
          <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
            <CheckSquare size={14} className="text-gray-300 dark:text-gray-600" />
            <span>{onNodeClick ? 'Showing live simulation path' : 'Reviewing optimized fleet solution'}</span>
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