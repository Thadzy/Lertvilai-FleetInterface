import React, { useCallback, useMemo, useEffect, useState, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  Panel,
  MarkerType,
  BackgroundVariant,
  type NodeProps,
  ConnectionLineType,
  applyNodeChanges,
  type NodeChange,
} from 'reactflow';

import 'reactflow/dist/style.css';
import { NodeResizer } from '@reactflow/node-resizer';
import '@reactflow/node-resizer/dist/style.css';
import {
  Save,
  PlusCircle,
  LayoutGrid,
  MousePointer2,
  Trash2,
  Upload,
  RefreshCw,
  XCircle,
  Link as LinkIcon,
  Box,
  ArrowUpFromLine,
  CircleDot,
  Layers,
  Edit3,
  Plus,
  ChevronDown,
  Lock,
  Unlock,
  Undo2,
  Redo2,
  Search,
  SquareDashedMousePointer,
} from 'lucide-react';


import { useGraphData, useGraphRealtime, loadCellOccupancy, type Level } from '../hooks/useGraphData';
import { supabase } from '../lib/supabaseClient';
import { useThemeStore } from '../store/themeStore';
import WaypointNode from './nodes/WaypointNode';
import ShelfNode from './nodes/ShelfNode';
import AnimatedEdge from './edges/AnimatedEdge';


// --- CENTRALIZED NODE COMPONENTS ---

/**
 * MapNode — displays the warehouse floor-plan image as a ReactFlow node.
 * Wraps NodeResizer so the operator can reposition/resize the background image.
 */
const MapNode = ({ data, selected }: NodeProps) => {
  return (
    <>
      <NodeResizer color="#3b82f6" isVisible={selected} minWidth={100} minHeight={100} />
      <img
        src={data.url}
        alt="Map Background"
        style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
        draggable={false}
      />
    </>
  );
};

/** Registered ReactFlow node types for the editor canvas. */
const nodeTypes = { waypointNode: WaypointNode, shelfNode: ShelfNode, mapNode: MapNode };

/** Registered ReactFlow edge types — animatedEdge is used for both base edges and path highlights. */
const edgeTypes = { animatedEdge: AnimatedEdge };

// ── Node Search Panel — must be rendered inside <ReactFlow> to use useReactFlow ──
const NodeSearchPanel: React.FC<{
  nodes: Node[];
  onHighlight: (id: string | null) => void;
}> = ({ nodes, onHighlight }) => {
  const { setCenter } = useReactFlow();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const searchable = nodes.filter(n => n.id !== 'map-background' && !n.hidden && n.data?.label);
  const results = query.trim().length > 1
    ? searchable.filter(n => (n.data.label as string).toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];

  const goTo = (node: Node) => {
    setCenter(node.position.x, node.position.y, { zoom: 1.5, duration: 600 });
    onHighlight(node.id);
    setTimeout(() => onHighlight(null), 2000);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-gray-200 dark:border-white/10 shadow-sm rounded-xl px-2.5 py-1.5">
        <Search size={12} className="text-gray-400 shrink-0" />
        <input
          type="text"
          placeholder="Search node..."
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="w-36 text-[11px] bg-transparent outline-none text-gray-700 dark:text-white placeholder-gray-400 font-mono"
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 left-0 w-52 bg-white dark:bg-[#1a1a1e] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl py-1 z-50">
          {results.map(n => (
            <button
              key={n.id}
              onMouseDown={() => goTo(n)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left hover:bg-blue-50 dark:hover:bg-white/5 transition-colors"
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                n.data.type === 'shelf' ? 'bg-cyan-500' :
                n.data.type === 'depot' ? 'bg-red-500' :
                n.data.type === 'conveyor' ? 'bg-amber-500' : 'bg-slate-400'
              }`} />
              <span className="font-mono font-bold text-gray-800 dark:text-white flex-1 truncate">{n.data.label}</span>
              <span className="text-[9px] text-gray-400 uppercase">{n.data.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// --- MAIN COMPONENT PROPS ---
interface GraphEditorProps {
  graphId: number;
  visualizedPath?: string[];
}

// --- MAIN COMPONENT ---
const GraphEditor: React.FC<GraphEditorProps> = ({ graphId, visualizedPath = [] }) => {
  const { theme } = useThemeStore();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Editor State
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [mapLocked, setMapLocked] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [toolMode, setToolMode] = useState<'move' | 'connect' | 'select'>('move');
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);

  // Undo / Redo history
  const historyRef = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const historyIndexRef = useRef(-1);
  const [, setHistoryVersion] = useState(0);
  const bumpHistoryVersion = useCallback(() => setHistoryVersion(v => v + 1), []);

  // Level State
  const [levels, setLevels] = useState<Level[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null); // null = ALL
  const [showLevelManager, setShowLevelManager] = useState(false);
  const [newLevelAlias, setNewLevelAlias] = useState('');
  const [newLevelHeight, setNewLevelHeight] = useState('0');

  // Shelf Detail State
  const [showShelfPanel, setShowShelfPanel] = useState(false);
  const [shelfCells, setShelfCells] = useState<{ id: number; alias: string; levelAlias: string | null; level_id: number | null }[]>([]);
  const [newCellLevel, setNewCellLevel] = useState('');
  const [newCellCol, setNewCellCol] = useState('1');

  // Toast Notification State
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: 'success' | 'error' | 'info' }[]>([]);

  /**
   * Display a temporary toast notification.
   */
  const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  // Custom Hook for Supabase Data
  const { loadGraph, saveGraph, loading, createLevel, deleteLevel, createCell, deleteCell, setNodeAsDepot } = useGraphData(graphId);

  // ── History helpers (undo/redo) ────────────────────────────────────────────
  
  /**
   * Capture the current state and push to history stack.
   * Clears any 'redo' forward history when a new action is performed.
   */
  const pushHistory = useCallback(() => {
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    historyRef.current.push({ 
      nodes: JSON.parse(JSON.stringify(nodes)), 
      edges: JSON.parse(JSON.stringify(edges)) 
    });
    historyIndexRef.current = historyRef.current.length - 1;
    bumpHistoryVersion();
  }, [nodes, edges, bumpHistoryVersion]);

  const undo = useCallback(() => {
    if (historyIndexRef.current < 0) return;
    
    const snap = historyRef.current[historyIndexRef.current];
    if (!snap) return;

    // Capture state to redo back to (if we are at the end)
    if (historyIndexRef.current === historyRef.current.length - 1) {
      // Optional: push current state as latest
    }

    historyIndexRef.current--;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    bumpHistoryVersion();
  }, [setNodes, setEdges, bumpHistoryVersion]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 2) return;
    
    historyIndexRef.current++;
    const snap = historyRef.current[historyIndexRef.current + 1];
    if (!snap) return;

    setNodes(snap.nodes);
    setEdges(snap.edges);
    bumpHistoryVersion();
  }, [setNodes, setEdges, bumpHistoryVersion]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = (navigator as any).userAgentData?.platform?.includes('Mac') ?? navigator.platform.includes('Mac');
      const ctrl = isMac ? e.metaKey : e.ctrlKey;
      if (!ctrl) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  // ── Highlight search effect ────────────────────────────────────────────────
  useEffect(() => {
    if (!highlightedNodeId) return;
    setNodes(prev => prev.map(n => n.id === highlightedNodeId
      ? { ...n, data: { ...n.data, highlighted: true } }
      : n.data?.highlighted ? { ...n, data: { ...n.data, highlighted: false } } : n
    ));
  }, [highlightedNodeId, setNodes]);

  // ── Cell occupancy polling ─────────────────────────────────────────────────
  const fetchOccupancy = useCallback(async () => {
    const occ = await loadCellOccupancy(graphId);
    if (occ.size === 0) return;
    setNodes(prev => prev.map(n => {
      if (n.data?.type !== 'shelf') return n;
      const cells = ((n.data.cells as any[]) || []).map((cell: any) => ({
        ...cell,
        occupancyStatus: occ.get(cell.id) || 'empty',
      }));
      return { ...n, data: { ...n.data, cells } };
    }));
  }, [graphId, setNodes]);

  useEffect(() => {
    fetchOccupancy();
    const occId = setInterval(fetchOccupancy, 10000); // Increased interval since we have realtime now
    return () => clearInterval(occId);
  }, [fetchOccupancy]);

  // ── Realtime Subscription ──
  const handleDataUpdate = useCallback(() => {
    console.log('[GraphEditor] Real-time update detected, reloading...');
    // We only reload graph structure (nodes/edges/levels)
    // Occupancy is still polled or we could add it to realtime too
    loadGraph().then(({ nodes: dbNodes, edges: dbEdges, levels: dbLevels, mapUrl }) => {
      // Preserve local-only data if needed, but usually we want to sync
      setNodes(dbNodes.map(n => {
        if (n.id === 'map-background') return { ...n, draggable: !mapLocked, selectable: !mapLocked };
        if (n.data?.type === 'shelf') return { ...n, data: { ...n.data, activeLevelId: selectedLevel } };
        return n;
      }));
      setEdges(dbEdges);
      setLevels(dbLevels);
      setBgUrl(mapUrl || null);
    });
  }, [loadGraph, mapLocked, selectedLevel, setNodes, setEdges]);

  useGraphRealtime(graphId, handleDataUpdate);

  // Helper: Get currently selected node
  const selectedNode = useMemo(() => nodes.find((n) => n.selected), [nodes]);

  // Helper: Update a specific property of the selected node
  const updateSelectedNode = (key: string, value: any) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.selected) {
          return { ...node, data: { ...node.data, [key]: value } };
        }
        return node;
      })
    );
  };

  // --- 1. LOAD DATA ---
  useEffect(() => {
    const fetchData = async () => {
      const { nodes: dbNodes, edges: dbEdges, mapUrl, levels: dbLevels } = await loadGraph();

      // Apply current lock state to the incoming map background node
      const preparedNodes = dbNodes.map(n => 
        n.id === 'map-background' ? { ...n, draggable: !mapLocked, selectable: !mapLocked } : n
      );

      setNodes(preparedNodes);
      setEdges(dbEdges);
      setBgUrl(mapUrl || null);
      setLevels(dbLevels);
    };

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  // ── Handle Level Selection ──
  const handleLevelSelect = (levelId: number | null) => {
    setSelectedLevel(levelId);
    setNodes(nds => nds.map(n => {
      if (n.data?.type === 'shelf') {
        return { ...n, data: { ...n.data, activeLevelId: levelId } };
      }
      return n;
    }));
  };

  // ── Handle Map Lock Toggle ──
  const handleMapLockToggle = () => {
    const nextLocked = !mapLocked;
    setMapLocked(nextLocked);
    setNodes(nds => nds.map(n => 
      n.id === 'map-background' ? { ...n, draggable: !nextLocked, selectable: !nextLocked } : n
    ));
  };

  // --- SHELF DETAIL: populate cells when a shelf is selected ---
  useEffect(() => {
    if (selectedNode && selectedNode.data?.type === 'shelf') {
      const shelfId = Number(selectedNode.id);
      if (!isNaN(shelfId)) {
        const cells = nodes
          .filter(n => n.data?.type === 'cell' && n.data?.shelf_id === shelfId)
          .map(n => ({
            id: Number(n.id),
            alias: n.data.label || 'unnamed',
            levelAlias: n.data.levelAlias || null,
            level_id: n.data.level_id || null,
          }));
        setShelfCells(cells);
        setShowShelfPanel(true);
      }
    } else {
      setShowShelfPanel(false);
    }
  }, [selectedNode, nodes]);

  // --- 2. PATH VISUALIZATION EFFECT ---
  useEffect(() => {
    if (!visualizedPath || visualizedPath.length < 2) {
      setEdges((eds) => {
        if (!eds.some(e => (e.style as any)?.stroke === '#22c55e')) return eds;
        return eds.map((e) => ({
          ...e,
          animated: false,
          style: { stroke: '#38bdf8', strokeWidth: 2 },
          zIndex: 0,
        }));
      });
      return;
    }

    const aliasToIdMap = new Map<string, string>();
    nodes.forEach(node => {
      if (node.data?.label) aliasToIdMap.set(node.data.label, node.id);
    });

    setEdges((eds) => {
      const pathEdgeIds = new Set<string>();
      for (let i = 0; i < visualizedPath.length - 1; i++) {
        const sourceId = aliasToIdMap.get(visualizedPath[i]);
        const targetId = aliasToIdMap.get(visualizedPath[i + 1]);
        if (sourceId && targetId) {
          const edge = eds.find(e =>
            (e.source === sourceId && e.target === targetId) ||
            (e.source === targetId && e.target === sourceId)
          );
          if (edge) pathEdgeIds.add(edge.id);
        }
      }
      return eds.map((e) =>
        pathEdgeIds.has(e.id)
          ? { ...e, animated: true, style: { stroke: '#22c55e', strokeWidth: 4 }, zIndex: 10 }
          : { ...e, animated: true, style: { stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '5,5', opacity: 0.5 }, zIndex: 0 }
      );
    });
  }, [visualizedPath, nodes, setEdges]);


  // --- 3. HANDLERS ---
  const onConnect = useCallback(
    (params: Connection) => {
      pushHistory();
      const newEdge = {
        ...params,
        type: 'animatedEdge',
        animated: false,
        style: { stroke: '#38bdf8', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#38bdf8' },
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges, pushHistory]
  );

  const addNode = (type: 'waypoint' | 'conveyor' | 'shelf' = 'waypoint') => {
    pushHistory();
    const id = `temp_${Date.now()}`;
    const prefixMap = { waypoint: 'W', conveyor: 'C', shelf: 'S' };
    const rfType = type === 'shelf' ? 'shelfNode' : 'waypointNode';
    const newNode: Node = {
      id,
      type: rfType,
      position: {
        x: 100 + Math.random() * 200,
        y: 100 + Math.random() * 200,
      },
      data: {
        label: `${prefixMap[type]}_${nodes.filter(n => n.data?.type === type).length + 1}`,
        type,
        height: type === 'conveyor' ? 1.0 : undefined,
        ...(type === 'shelf' ? { cells: [], activeLevelId: selectedLevel } : {}),
      },
    };
    setNodes((nds) => nds.concat(newNode));
    setToolMode('move');
  };

  const handleDelete = useCallback(() => {
    pushHistory();
    setNodes((nds) => nds.filter((node) => !node.selected || node.data?.type === 'depot' || node.data?.type === 'cell'));
    setEdges((eds) => eds.filter((edge) => !edge.selected));
  }, [setNodes, setEdges, pushHistory]);

  const onNodeDragStart = useCallback(() => {
    pushHistory();
  }, [pushHistory]);

  const onNodeDragStop = useCallback(() => {
    // History was already pushed at start; drag stop is usually implicit update
  }, []);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setUploading(true);
      const fileName = `map_${graphId}_${Date.now()}_${file.name.replace(/\s/g, '')}`;
      const { error: uploadError } = await supabase.storage.from('maps').upload(fileName, file);
      if (uploadError) throw uploadError;
      const { data: { publicUrl } } = supabase.storage.from('maps').getPublicUrl(fileName);
      await supabase.from('wh_graphs').update({ map_url: publicUrl }).eq('id', graphId);
      setBgUrl(publicUrl);
      showToast('Map uploaded successfully!', 'success');
    } catch (error: unknown) {
      showToast(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setUploading(false);
      if (event.target) event.target.value = '';
    }
  };

  const handleRemoveBackground = async () => {
    if (!window.confirm("Are you sure you want to remove the background map?")) return;
    try {
      setUploading(true);
      await supabase.from('wh_graphs').update({ map_url: null }).eq('id', graphId);
      setBgUrl(null);
    } catch {
      showToast('Failed to remove background image', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleCreateLevel = async () => {
    if (!newLevelAlias.trim()) return;
    try {
      const result = await createLevel(newLevelAlias.trim(), parseFloat(newLevelHeight) || 0);
      if (result) {
        setNewLevelAlias('');
        setNewLevelHeight('0');
        showToast(`Level "${newLevelAlias.trim()}" created`, 'success');
        handleDataUpdate();
      }
    } catch (err) {
      showToast(`Failed to create level: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleDeleteLevel = async (levelId: number) => {
    if (!window.confirm('Delete this level? All cells on this level will also be deleted.')) return;
    try {
      const success = await deleteLevel(levelId);
      if (success) {
        showToast('Level deleted', 'success');
        handleDataUpdate();
        if (selectedLevel === levelId) setSelectedLevel(null);
      }
    } catch (err) {
      showToast(`Failed to delete level: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleCreateCell = async () => {
    if (!selectedNode || selectedNode.data?.type !== 'shelf') return;
    if (!newCellLevel) return;

    const shelfAlias: string = selectedNode.data.label ?? '';
    const levelObj = levels.find(l => l.id === parseInt(newCellLevel));
    if (!levelObj) return;

    const shelfNumMatch = shelfAlias.match(/(\d+)/);
    const shelfNum = shelfNumMatch ? shelfNumMatch[1] : shelfAlias;
    const cellNum = parseInt(newCellCol) || 1;
    const levelNumMatch = levelObj.alias.match(/(\d+)/);
    const levelNum = levelNumMatch ? levelNumMatch[1] : levelObj.alias;
    const cellAlias = `S${shelfNum}C${cellNum}L${levelNum}`;

    try {
      const result = await createCell(shelfAlias, levelObj.alias, cellAlias);
      if (result) {
        setNewCellLevel('');
        setNewCellCol('1');
        showToast(`Cell "${cellAlias}" created`, 'success');
        handleDataUpdate();
      }
    } catch (err) {
      showToast(`Failed to create cell: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleDeleteCell = async (cellId: number) => {
    if (!window.confirm('Delete this cell?')) return;
    try {
      const success = await deleteCell(cellId);
      if (success) {
        showToast('Cell deleted', 'success');
        handleDataUpdate();
      }
    } catch (err) {
      showToast(`Failed to delete cell: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const reloadGraphStructure = async () => {
    try {
      const { nodes: dbNodes, edges: dbEdges, mapUrl, levels: dbLevels } = await loadGraph();
      setNodes(dbNodes);
      setEdges(dbEdges);
      setBgUrl(mapUrl || null);
      setLevels(dbLevels);
    } catch (err) {
      showToast(`Reload failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const [showAddMenu, setShowAddMenu] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAddMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showAddMenu]);


  return (
    <div className="w-full h-full bg-gray-50 dark:bg-[#09090b] text-gray-900 dark:text-white relative font-sans transition-colors">

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        fitView
        minZoom={0.1}
        maxZoom={4}
        defaultEdgeOptions={{
          type: 'animatedEdge',
          style: { stroke: theme === 'dark' ? '#3b82f6' : '#2563eb', strokeWidth: 3 },
          markerEnd: { type: MarkerType.ArrowClosed, color: theme === 'dark' ? '#3b82f6' : '#2563eb' }
        }}

        connectionLineType={ConnectionLineType.Straight}
        nodesDraggable={toolMode === 'move'}
        nodesConnectable={toolMode === 'connect'}
        panOnDrag={toolMode === 'move'}
        selectionOnDrag={toolMode === 'select'}
        multiSelectionKeyCode="Shift"
        onPaneClick={() => setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))}
      >

        <Background color={theme === 'dark' ? '#1e293b' : '#cbd5e1'} gap={20} size={1} variant={BackgroundVariant.Dots} />

        {/* Node Search Panel */}
        <Panel position="top-right" className="m-4">
          <NodeSearchPanel nodes={nodes} onHighlight={setHighlightedNodeId} />
        </Panel>


        {/* --- HEADER INFO --- */}
        <Panel position="top-left" className="m-4">
          <div className="bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-gray-200 dark:border-white/10 shadow-sm px-4 py-3 rounded-xl flex items-center gap-3">
            <div className="p-2 bg-gray-100 dark:bg-white/5 rounded-lg text-blue-600 dark:text-blue-400">
              <LayoutGrid size={20} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-gray-900 dark:text-white leading-tight">Map Designer</h2>
              <div className="text-[10px] text-slate-500 font-mono flex items-center gap-2">
                <span>EDITING ID: <span className="text-blue-600 font-bold">#{graphId}</span></span>
                {loading && <span className="text-amber-500 animate-pulse">(SYNCING...)</span>}
              </div>
            </div>

            {visualizedPath.length > 0 && (
              <div className="ml-4 px-3 py-1 bg-green-100 border border-green-200 text-green-700 text-xs font-bold rounded-full flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                VISUALIZING PATH ({visualizedPath.length} STEPS)
              </div>
            )}
          </div>

          {/* --- LEVEL SELECTOR --- */}
          <div className="mt-2 bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-gray-200 dark:border-white/10 shadow-sm px-3 py-2 rounded-xl">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                <Layers size={10} /> Level Filter
              </span>
              <button
                onClick={() => setShowLevelManager(!showLevelManager)}
                className="text-[10px] text-blue-600 hover:text-blue-800 font-bold"
              >
                {showLevelManager ? 'Close' : 'Manage'}
              </button>
            </div>

            <div className="flex gap-1 flex-wrap">
              <button
                onClick={() => handleLevelSelect(null)}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-full transition-all ${selectedLevel === null
                    ? 'bg-slate-800 text-white shadow-md'
                    : 'bg-gray-100 dark:bg-white/5 text-slate-500 hover:bg-slate-200'
                  }`}
              >
                ALL
              </button>
              {levels.map((level) => (
                <button
                  key={level.id}
                  onClick={() => handleLevelSelect(level.id)}
                  className={`px-2.5 py-1 text-[10px] font-bold rounded-full transition-all ${selectedLevel === level.id
                      ? 'bg-purple-600 text-white shadow-md'
                      : 'bg-purple-50 text-purple-600 hover:bg-purple-100'
                    }`}
                >
                  {level.alias}
                </button>
              ))}
              {levels.length === 0 && (
                <span className="text-[10px] text-gray-500 dark:text-gray-400 italic py-1">No levels defined</span>
              )}
            </div>

            {/* Level Manager */}
            {showLevelManager && (
              <div className="mt-2 pt-2 border-t border-gray-200 dark:border-white/10">
                <div className="flex gap-1 mb-2">
                  <input
                    type="text"
                    placeholder="Alias (L1)"
                    value={newLevelAlias}
                    onChange={(e) => setNewLevelAlias(e.target.value)}
                    className="flex-1 text-[10px] px-2 py-1 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-[#09090b] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="number"
                    placeholder="Height"
                    value={newLevelHeight}
                    onChange={(e) => setNewLevelHeight(e.target.value)}
                    className="w-16 text-[10px] px-2 py-1 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-[#09090b] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500"
                    step="0.1"
                    min="0"
                  />
                  <button
                    onClick={handleCreateLevel}
                    className="px-2 py-1 bg-purple-600 text-white text-[10px] font-bold rounded hover:bg-purple-700"
                  >
                    <Plus size={10} />
                  </button>
                </div>
                {levels.map((level) => (
                  <div key={level.id} className="flex items-center justify-between py-1 text-[10px]">
                    <span className="font-mono font-bold text-blue-600 dark:text-blue-400">{level.alias}</span>
                    <span className="text-gray-500 dark:text-gray-400">h={level.height}m</span>
                    <button
                      onClick={() => handleDeleteLevel(level.id)}
                      className="text-red-400 hover:text-red-600"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>

        {/* --- RIGHT TOOLBAR --- */}
        <Panel position="top-right" className="m-4 flex flex-col gap-2 items-end">

          {/* NODE PROPERTIES PANEL */}
          {selectedNode && selectedNode.id !== 'map-background' && (
            <div className="bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-blue-200 shadow-xl rounded-xl p-3 flex flex-col gap-2 w-64 animate-in slide-in-from-right-4">
              <div className="flex items-center gap-2 text-blue-600 border-b border-blue-100 pb-2 mb-1">
                <Edit3 size={14} />
                <span className="text-xs font-bold uppercase">Edit Node Props</span>
              </div>

              {/* Name Input */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase">Node Name</label>
                <input
                  type="text"
                  value={selectedNode.data.label}
                  onChange={(e) => updateSelectedNode('label', e.target.value)}
                  className="text-xs border border-slate-300 rounded px-2 py-1 focus:outline-none focus:border-blue-500 font-mono"
                  disabled={selectedNode.data.type === 'depot' || selectedNode.data.type === 'cell'}
                />
              </div>

              {/* Type Select (only for non-depot, non-cell) */}
              {selectedNode.data.type !== 'depot' && selectedNode.data.type !== 'cell' && (
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase">Node Type</label>
                  <select
                    value={selectedNode.data.type || 'waypoint'}
                    onChange={(e) => updateSelectedNode('type', e.target.value)}
                    className="text-xs border border-slate-300 rounded px-2 py-1 focus:outline-none focus:border-blue-500 bg-white dark:bg-[#121214]"
                  >
                    <option value="waypoint">Waypoint</option>
                    <option value="conveyor">Conveyor</option>
                    <option value="shelf">Shelf</option>
                  </select>
                </div>
              )}

              {/* Set as Depot Button */}
              {selectedNode && !isNaN(Number(selectedNode.id)) && (selectedNode.data.type === 'waypoint' || selectedNode.data.type === 'conveyor') && (
                <button
                  onClick={async () => {
                    const nodeId = Number(selectedNode.id);
                    if (window.confirm(`Set "${selectedNode.data.label}" as the depot? The current depot will move here and "${selectedNode.data.label}" will be merged into it.`)) {
                      try {
                        const success = await setNodeAsDepot(nodeId);
                        if (success) {
                          showToast('Depot moved successfully', 'success');
                          await reloadGraphStructure();
                        }
                      } catch (err: unknown) {
                        showToast(`Failed to set depot: ${err instanceof Error ? err.message : String(err)}`, 'error');
                      }
                    }
                  }}
                  className="mt-1 flex items-center justify-center gap-2 px-3 py-1.5 bg-red-600/90 text-white text-[10px] font-bold rounded hover:bg-red-700 shadow-sm transition-all active:translate-y-0.5"
                >
                  <CircleDot size={12} />
                  SET AS DEPOT
                </button>
              )}

              {/* Depot indicator */}
              {selectedNode.data.type === 'depot' && (
                <div className="text-[10px] text-red-500 font-bold bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded">
                  ⚠ Depot node — cannot be deleted or renamed
                </div>
              )}

              {/* Cell indicator */}
              {selectedNode.data.type === 'cell' && (
                <div className="text-[10px] text-purple-500 font-bold bg-purple-50 dark:bg-purple-900/20 px-2 py-1 rounded">
                  Cell — managed through Shelf panel
                </div>
              )}

              {/* Conveyor Height */}
              {selectedNode.data.type === 'conveyor' && (
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase flex items-center gap-1">
                    <ArrowUpFromLine size={10} /> Height (m)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={selectedNode.data.height ?? 1.0}
                    onChange={(e) => updateSelectedNode('height', parseFloat(e.target.value) || 0)}
                    className="text-xs border border-slate-300 rounded px-2 py-1 font-mono focus:outline-none focus:border-blue-500"
                  />
                </div>
              )}

              {/* Shelf: Cell Management */}
              {selectedNode.data.type === 'shelf' && showShelfPanel && (
                <div className="border-t border-gray-200 dark:border-white/10 pt-2 mt-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold text-cyan-600 uppercase flex items-center gap-1">
                      <Box size={10} /> Cells in "{selectedNode.data.label}"
                    </span>
                  </div>

                  {/* Existing Cells */}
                  {shelfCells.length === 0 && (
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 italic mb-2">No cells yet</p>
                  )}
                  {shelfCells.map((cell) => (
                    <div key={cell.id} className="flex items-center justify-between py-1 text-[10px] border-b border-slate-50 dark:border-white/5">
                      <span className="font-mono font-bold text-blue-600 dark:text-blue-400">{cell.alias}</span>
                      <span className="text-purple-500 font-bold">{cell.levelAlias || '?'}</span>
                      <button
                        onClick={() => handleDeleteCell(cell.id)}
                        className="text-red-400 hover:text-red-600"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}

                  {/* Add Cell Form */}
                  {levels.length > 0 ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <div className="flex gap-1">
                        <input
                          type="number"
                          placeholder="Col (C)"
                          value={newCellCol}
                          onChange={(e) => setNewCellCol(e.target.value)}
                          min="1"
                          className="w-16 text-[10px] px-2 py-1 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-[#09090b] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500"
                        />
                        <select
                          value={newCellLevel}
                          onChange={(e) => setNewCellLevel(e.target.value)}
                          className="flex-1 text-[10px] px-1 py-1 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-[#09090b] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500"
                        >
                          <option value="">Select level…</option>
                          {levels.map(l => (
                            <option key={l.id} value={l.id}>{l.alias}</option>
                          ))}
                        </select>
                        <button
                          onClick={handleCreateCell}
                          disabled={!newCellLevel}
                          className="px-2 py-1 bg-cyan-600 text-white text-[10px] font-bold rounded hover:bg-cyan-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Plus size={10} />
                        </button>
                      </div>
                      {/* Preview the auto-generated alias */}
                      {newCellLevel && (() => {
                        const levelObj = levels.find(l => l.id === parseInt(newCellLevel));
                        const shelfAlias: string = selectedNode?.data?.label ?? '';
                        const shelfNum = (shelfAlias.match(/(\d+)/) ?? [, shelfAlias])[1];
                        const levelNum = levelObj ? (levelObj.alias.match(/(\d+)/) ?? [, levelObj.alias])[1] : '?';
                        const cellNum = parseInt(newCellCol) || '?';
                        return (
                          <p className="text-[9px] text-cyan-600 font-mono mt-0.5">
                            Will create: <strong>S{shelfNum}C{cellNum}L{levelNum}</strong>
                          </p>
                        );
                      })()}
                    </div>
                  ) : (
                    <p className="text-[10px] text-amber-500 mt-2">Create levels first before adding cells</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* GLOBAL TOOLS BUTTONS */}
          <div className="bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-gray-200 dark:border-white/10 shadow-lg rounded-xl p-1.5 flex gap-1">
            <div className="flex gap-1 pr-2 border-r border-gray-200 dark:border-white/10 items-center">

              {/* Map Controls */}
              {bgUrl && (
                <>
                  <button onClick={handleRemoveBackground} className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all" title="Remove Map">
                    <XCircle size={18} />
                  </button>
                  <button onClick={handleMapLockToggle} className={`p-2 rounded-lg transition-all ${!mapLocked ? 'bg-amber-100 text-amber-600 shadow-sm' : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'}`} title={mapLocked ? "Unlock Map for Editing" : "Unlock Map"}>
                    {mapLocked ? <Lock size={18} /> : <Unlock size={18} />}
                  </button>
                </>
              )}

              <label className="cursor-pointer p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all group relative" title="Upload Map">
                <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                <Upload size={18} />
              </label>

              {/* Tool Switcher */}
              <button
                onClick={() => setToolMode('move')}
                className={`p-2 rounded-lg transition-all ${toolMode === 'move'
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'
                  }`}
                title="Move Tool"
              >
                <MousePointer2 size={18} />
              </button>

              <button
                onClick={() => setToolMode('connect')}
                className={`p-2 rounded-lg transition-all ${toolMode === 'connect'
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'
                  }`}
                title="Connect Tool"
              >
                <LinkIcon size={18} />
              </button>

              <button
                onClick={() => setToolMode('select')}
                className={`p-2 rounded-lg transition-all ${toolMode === 'select'
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'
                  }`}
                title="Select Tool — drag to multi-select (Shift+click also works)"
              >
                <SquareDashedMousePointer size={18} />
              </button>

              <div className="w-px h-5 bg-gray-200 dark:bg-white/10 self-center mx-0.5" />

              <button
                onClick={undo}
                disabled={historyIndexRef.current < 0}
                className="p-2 rounded-lg transition-all text-slate-500 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Undo (Ctrl+Z)"
              >
                <Undo2 size={18} />
              </button>

              <button
                onClick={redo}
                disabled={historyIndexRef.current >= historyRef.current.length - 2}
                className="p-2 rounded-lg transition-all text-slate-500 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Redo (Ctrl+Shift+Z)"
              >
                <Redo2 size={18} />
              </button>

              {/* Add Node — dropdown */}
              <div className="relative" ref={addMenuRef}>
                <button
                  onClick={() => setShowAddMenu(!showAddMenu)}
                  className="p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all flex items-center gap-0.5"
                  title="Add Node"
                >
                  <PlusCircle size={18} />
                  <ChevronDown size={10} />
                </button>
                {showAddMenu && (
                  <div className="absolute top-full right-0 mt-1 bg-white dark:bg-[#121214] border border-gray-200 dark:border-white/10 rounded-lg shadow-xl py-1 z-50 w-36">
                    <button
                      onClick={() => { addNode('waypoint'); setShowAddMenu(false); }}
                      className="w-full px-3 py-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-white/10 text-gray-900 dark:text-white transition-colors flex items-center gap-2"
                    >
                      <CircleDot size={12} className="text-blue-600 dark:text-blue-400" /> Waypoint
                    </button>
                    <button
                      onClick={() => { addNode('conveyor'); setShowAddMenu(false); }}
                      className="w-full px-3 py-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-white/10 text-gray-900 dark:text-white transition-colors flex items-center gap-2"
                    >
                      <ArrowUpFromLine size={12} className="text-amber-600" /> Conveyor
                    </button>
                    <button
                      onClick={() => { addNode('shelf'); setShowAddMenu(false); }}
                      className="w-full px-3 py-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-white/10 text-gray-900 dark:text-white transition-colors flex items-center gap-2"
                    >
                      <Box size={12} className="text-cyan-600" /> Shelf
                    </button>
                  </div>
                )}
              </div>

              <button
                onMouseDown={(e) => { e.preventDefault(); handleDelete(); }}
                className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                title="Delete Selected"
              >
                <Trash2 size={18} />
              </button>
            </div>

            {/* Sync Actions */}
            <div className="flex gap-1 pl-1">
              <button
                onClick={reloadGraphStructure}
                className="p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:bg-white/5 rounded-lg transition-all"
                title="Reload"
              >
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
              </button>

              <button
                onClick={async () => {
                  try {
                    const success = await saveGraph(nodes, edges, bgUrl);
                    if (success) {
                      await reloadGraphStructure();
                      showToast('Graph configuration saved successfully', 'success');
                    } else {
                      showToast('Save returned no confirmation — check console', 'error');
                    }
                  } catch (err) {
                    showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
                  }
                }}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-lg hover:bg-slate-700 shadow-md transition-all active:translate-y-0.5"
              >
                <Save size={14} />
                <span>Save Complete</span>
              </button>
            </div>
          </div>
        </Panel>

        {/* --- BOTTOM STATUS BAR --- */}
        <Panel position="bottom-center" className="mb-2">
          <div className="bg-slate-800/90 backdrop-blur text-slate-300 text-[10px] font-mono px-4 py-1.5 rounded-full flex gap-4 shadow-lg border border-gray-300 dark:border-white/10">
            <span>MODE: <span className="text-white font-bold">{toolMode.toUpperCase()}</span></span>
            <span className="text-blue-600 dark:text-blue-400">|</span>
            <span>NODES: {nodes.filter((n) => n.id !== 'map-background').length}</span>
            <span className="text-blue-600 dark:text-blue-400">|</span>
            <span>EDGES: {edges.length}</span>
            {selectedLevel !== null && (
              <>
                <span className="text-blue-600 dark:text-blue-400">|</span>
                <span>LEVEL: <span className="text-purple-400 font-bold">{levels.find(l => l.id === selectedLevel)?.alias || '?'}</span></span>
              </>
            )}
          </div>
        </Panel>

        {/* --- TOAST NOTIFICATIONS --- */}
        <Panel position="bottom-right" className="mb-12 mr-2 flex flex-col gap-1.5 pointer-events-none">
          {toasts.map(t => (
            <div
              key={t.id}
              className={`px-3 py-2 rounded-lg text-xs font-bold shadow-lg border backdrop-blur-sm animate-in slide-in-from-right-4 fade-in ${
                t.type === 'success'
                  ? 'bg-green-500/90 border-green-400/50 text-white'
                  : t.type === 'error'
                    ? 'bg-red-500/90 border-red-400/50 text-white'
                    : 'bg-slate-800/90 border-white/10 text-slate-100'
              }`}
            >
              {t.msg}
            </div>
          ))}
        </Panel>

        <Controls />
        <MiniMap
          position="bottom-left"
          className="!bg-gray-100 dark:bg-white/5 border border-slate-300 rounded-lg"
          nodeColor={(n) => {
            const type = n.data?.type || 'waypoint';
            if (type === 'shelf') return '#0891b2';
            if (type === 'conveyor') return '#d97706';
            if (type === 'cell') return '#a855f7';
            if (type === 'depot') return '#dc2626';
            return '#475569';
          }}
        />
      </ReactFlow>
    </div>
  );
};

export default GraphEditor;
