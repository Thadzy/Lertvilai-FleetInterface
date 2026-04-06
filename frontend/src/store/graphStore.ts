import { create } from 'zustand';
import {
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  Connection,
} from 'reactflow';

interface GraphState {
  nodes: Node[];
  edges: Edge[];
  undoStack: { nodes: Node[]; edges: Edge[] }[];
  redoStack: { nodes: Node[]; edges: Edge[] }[];
  isDirty: boolean;
  snapToGrid: boolean;

  // Actions
  setNodes: (nodes: Node[] | ((nds: Node[]) => Node[])) => void;
  setEdges: (edges: Edge[] | ((eds: Edge[]) => Edge[])) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  
  // History
  takeSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  
  // Settings
  toggleSnapToGrid: () => void;
  setDirty: (dirty: boolean) => void;
  resetGraph: (nodes: Node[], edges: Edge[]) => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  undoStack: [],
  redoStack: [],
  isDirty: false,
  snapToGrid: true,

  setNodes: (nodes) => {
    set((state) => ({
      nodes: typeof nodes === 'function' ? nodes(state.nodes) : nodes,
      isDirty: true,
    }));
  },

  setEdges: (edges) => {
    set((state) => ({
      edges: typeof edges === 'function' ? edges(state.edges) : edges,
      isDirty: true,
    }));
  },

  onNodesChange: (changes) => {
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      isDirty: true,
    }));
  },

  onEdgesChange: (changes) => {
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      isDirty: true,
    }));
  },

  onConnect: (connection) => {
    get().takeSnapshot();
    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          type: 'animatedEdge',
          animated: false,
          style: { stroke: '#38bdf8', strokeWidth: 2 },
        },
        state.edges
      ),
      isDirty: true,
    }));
  },

  takeSnapshot: () => {
    const { nodes, edges, undoStack } = get();
    // Only take snapshot if state changed
    const lastSnap = undoStack[undoStack.length - 1];
    if (lastSnap && JSON.stringify(lastSnap.nodes) === JSON.stringify(nodes) && JSON.stringify(lastSnap.edges) === JSON.stringify(edges)) {
      return;
    }

    set((state) => ({
      undoStack: [...state.undoStack, { nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) }].slice(-50), // Limit history to 50
      redoStack: [], // Clear redo on new action
    }));
  },

  undo: () => {
    const { undoStack, nodes, edges } = get();
    if (undoStack.length === 0) return;

    const prev = undoStack[undoStack.length - 1];
    const newStack = undoStack.slice(0, -1);

    set((state) => ({
      redoStack: [{ nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) }, ...state.redoStack],
      nodes: prev.nodes,
      edges: prev.edges,
      undoStack: newStack,
      isDirty: true,
    }));
  },

  redo: () => {
    const { redoStack, nodes, edges } = get();
    if (redoStack.length === 0) return;

    const next = redoStack[0];
    const newStack = redoStack.slice(1);

    set((state) => ({
      undoStack: [...state.undoStack, { nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) }],
      nodes: next.nodes,
      edges: next.edges,
      redoStack: newStack,
      isDirty: true,
    }));
  },

  toggleSnapToGrid: () => set((state) => ({ snapToGrid: !state.snapToGrid })),
  
  setDirty: (dirty) => set({ isDirty: dirty }),

  resetGraph: (nodes, edges) => set({
    nodes,
    edges,
    undoStack: [],
    redoStack: [],
    isDirty: false
  }),
}));
