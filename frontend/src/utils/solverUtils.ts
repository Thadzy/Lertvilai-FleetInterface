import { type DBNode, type DBEdge } from '../types/database';

// =========================================================
// 1. MATH & GRAPH HELPERS
// =========================================================

/**
 * Calculates Euclidean distance between two nodes.
 * @returns Distance in raw units (meters in this app).
 */
export const getDist = (a: DBNode, b: DBNode): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Generates an All-Pairs Shortest Path Matrix using the Floyd-Warshall Algorithm.
 * * WHY IS THIS NEEDED?
 * The VRP Solver (OR-Tools) requires a cost matrix where matrix[i][j] represents
 * the travel cost from Node i to Node j.
 * * COMPLEXITY WARNING:
 * This runs in O(n^3). For a warehouse with < 200 nodes, it's instant (~5ms).
 * For > 500 nodes, this calculation should be moved to the Backend/Server.
 */
export const generateDistanceMatrix = (nodes: DBNode[], edges: DBEdge[]): number[][] => {
  const n = nodes.length;
  // Initialize with Infinity (representing no direct path)
  const dist: number[][] = Array(n).fill(null).map(() => Array(n).fill(Infinity));

  // Create a quick lookup map: NodeID -> Matrix Index (0 to n-1)
  const idToIndex = new Map<number, number>();
  nodes.forEach((node, index) => {
    idToIndex.set(node.id, index);
    dist[index][index] = 0; // Distance to self is 0
  });

  // Populate matrix with direct edge weights
  edges.forEach(edge => {
    const u = idToIndex.get(edge.node_a_id);
    const v = idToIndex.get(edge.node_b_id);
    const nodeA = nodes.find(n => n.id === edge.node_a_id);
    const nodeB = nodes.find(n => n.id === edge.node_b_id);

    if (u !== undefined && v !== undefined && nodeA && nodeB) {
      // SCALING: Convert Meters to Centimeters (Integers are faster for solvers)
      const weight = Math.round(getDist(nodeA, nodeB) * 100);

      // Assume bidirectional edges for now
      dist[u][v] = weight;
      dist[v][u] = weight;
    }
  });

  // Floyd-Warshall Logic: Find shortest path via intermediate node 'k'
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (dist[i][k] + dist[k][j] < dist[i][j]) {
          dist[i][j] = dist[i][k] + dist[k][j];
        }
      }
    }
  }

  // Final Polish: Convert remaining Infinity or NaN to a very large number
  // NOTE: OR-Tools requires non-negative integers. Using 999999 (= ~10km in cm) for unreachable.
  return dist.map(row =>
    row.map(val => (val === Infinity || Number.isNaN(val) || val === null ? 999999 : val))
  );
};

/**
 * Formats user-selected tasks into simple [PickupIndex, DeliveryIndex] pairs.
 * * NOTE: This function attempts to map Task Names back to Node Indices because
 * the frontend 'Task' object might strictly contain IDs.
 */
export const formatTasksForSolver = (tasks: any[], nodes: DBNode[]): number[][] => {
  const aliasToIndex = new Map<string, number>();
  nodes.forEach((node, index) => aliasToIndex.set(node.alias, index));

  return tasks.map(t => {
    // Attempt 1: Try to match by Node Alias (Robust)
    // Note: useTasks hook populates pickup_name/delivery_name with ALIAS now.
    let pickupIdx = aliasToIndex.get(t.pickup_name);
    let deliveryIdx = aliasToIndex.get(t.delivery_name);

    // Fallback: If map fails, default to generic indices (0, 1) to prevent crash
    // In production, this should throw an error or filter out the task.
    if (pickupIdx === undefined) pickupIdx = 1;
    if (deliveryIdx === undefined) deliveryIdx = 2;

    return [pickupIdx, deliveryIdx];
  });
};

// =========================================================
// 2. MOCK SOLVER (SIMULATION MODE)
// =========================================================

/**
 * Simulates a VRP Solver response.
 * Creates a route that simply visits every requested task in order.
 * * VISUALIZATION TIP:
 * Takes the [Pick, Drop] pairs and constructs a sequential path:
 * Depot -> Pick A -> Drop A -> Pick B -> Drop B -> Depot
 */
/**
 * Step in a VRP Route.
 */
export interface RouteStep {
  type: 'move' | 'pickup' | 'dropoff';
  node_id: number;
  request_id?: number;
  cell_id?: number; // Corresponding cell_id for the action
}

// =========================================================
// 3. REAL SOLVER (HYBRID: API + SIMULATION FALLBACK)
// =========================================================

export const solveVRP = async (matrix: number[][], tasks: any[], nodes: DBNode[], cells: any[]) => {
  console.log("PRODUCTION MODE: Calling VRP Broker...");

  // 1. Format Payload for Python API
  // We need to send the matrix and the requests (pickup/dropoff indices)
  // Map Node IDs to Matrix Indices (assumes nodes array order == matrix index)
  const nodeToIdx = new Map<number, number>();
  nodes.forEach((n, i) => nodeToIdx.set(n.id, i));

  // Helper: Find Node ID for a Cell ID
  const getCellNodeId = (cellId: number) => {
    const c = cells.find(c => c.id === cellId);
    return c ? c.node_id : null;
  };

  // Convert Tasks to [PickupIndex, DeliveryIndex] pairs
  // Filter out any invalid tasks where cells/nodes don't map correctly
  const validTasks: any[] = [];
  const apiRequests: number[][] = [];

  tasks.forEach(t => {
    const pNodeId = getCellNodeId(t.pickup_cell_id);
    const dNodeId = getCellNodeId(t.delivery_cell_id);

    if (pNodeId && dNodeId && nodeToIdx.has(pNodeId) && nodeToIdx.has(dNodeId)) {
      validTasks.push(t);
      apiRequests.push([nodeToIdx.get(pNodeId)!, nodeToIdx.get(dNodeId)!]);
    }
  });

  const payload = {
    matrix: matrix,
    requests: apiRequests,
    vehicle_count: 1
  };

  try {
    // Use Vite proxy path to avoid CORS/mixed-content issues and ensure connectivity
    const response = await fetch('/api/vrp/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Server Error: ${response.status}`);

    const result = await response.json();

    if (!result.routes || result.routes.length === 0) {
      throw new Error("No solution returned");
    }

    // 2. Parse Solution (Node Index Sequence -> RouteSteps)
    const rawRoute = result.routes[0].nodes; // e.g. [0, 5, 2, 8, 0]

    const routeSteps: RouteStep[] = [];

    // We need to track which tasks we've handled to decide if a visit is a Pickup or Dropoff
    // Simple Heuristic: First visit to a task's location is Pickup? 
    // Or check against validTasks list.
    const taskState = new Map<number, 'pending' | 'picked_up' | 'delivered'>();
    validTasks.forEach(t => taskState.set(t.id, 'pending'));

    rawRoute.forEach((nodeIdx: number) => {
      const nodeId = nodes[nodeIdx].id;

      // Is this node a location for any task?
      // Find tasks where pickup/delivery matches this node
      const activeTask = validTasks.find(t => {
        const pNode = getCellNodeId(t.pickup_cell_id);
        const dNode = getCellNodeId(t.delivery_cell_id);

        if (pNode === nodeId && taskState.get(t.id) === 'pending') return true; // It's a pickup
        if (dNode === nodeId && taskState.get(t.id) === 'picked_up') return true; // It's a delivery
        return false;
      });

      let stepType: 'move' | 'pickup' | 'dropoff' = 'move';
      let relatedTaskId = undefined;
      let relatedCellId = undefined;

      if (activeTask) {
        if (taskState.get(activeTask.id) === 'pending') {
          stepType = 'pickup';
          taskState.set(activeTask.id, 'picked_up');
          relatedTaskId = activeTask.id;
          relatedCellId = activeTask.pickup_cell_id;
        } else {
          stepType = 'dropoff';
          taskState.set(activeTask.id, 'delivered');
          relatedTaskId = activeTask.id;
          relatedCellId = activeTask.delivery_cell_id;
        }
      }

      routeSteps.push({
        type: stepType,
        node_id: nodeId,
        request_id: relatedTaskId,
        cell_id: relatedCellId
      });
    });

    return {
      feasible: true,
      total_distance: result.total_distance,
      wall_time_ms: result.wall_time_ms,
      routes: [{ vehicle_id: 1, steps: routeSteps, distance: result.total_distance }],
      summary: "Optimized by Python VRP Engine"
    };

  } catch (error) {
    console.warn("VRP API Failed (CORS/Offline), falling back to LOCAL SIMULATION.", error);

    // FALLBACK: Run the original Mock Simulation Logic
    // ------------------------------------------------
    await new Promise(resolve => setTimeout(resolve, 600)); // Fake delay

    const depotNode = nodes.find(n => n.type === 'depot') || nodes[0];
    const routeSteps: RouteStep[] = [];

    // Initial Move
    routeSteps.push({ type: 'move', node_id: depotNode.id });

    let totalDistance = 0;
    let lastNodeId = depotNode.id;

    // Greedy Sequence based on input order
    tasks.forEach((task) => {
      // Pickup
      const pickupCell = cells.find(c => c.id === task.pickup_cell_id);
      const pickupNodeId = pickupCell ? pickupCell.node_id : lastNodeId;
      routeSteps.push({ type: 'pickup', node_id: pickupNodeId, request_id: task.id, cell_id: task.pickup_cell_id });
      totalDistance += 500;

      // Delivery
      const deliveryCell = cells.find(c => c.id === task.delivery_cell_id);
      const deliveryNodeId = deliveryCell ? deliveryCell.node_id : pickupNodeId;
      routeSteps.push({ type: 'dropoff', node_id: deliveryNodeId, request_id: task.id, cell_id: task.delivery_cell_id });
      totalDistance += 500;

      lastNodeId = deliveryNodeId;
    });

    // Return to start
    routeSteps.push({ type: 'move', node_id: depotNode.id });

    return {
      feasible: true,
      total_distance: totalDistance,
      wall_time_ms: 50,
      routes: [{ vehicle_id: 1, steps: routeSteps, distance: totalDistance }],
      summary: "Simulation (Server Offline)"
    };
  }
};

// Export alias for compatibility if needed
export const mockSolveVRP = solveVRP;


// =========================================================
// 4. A* PATHFINDING (LOCAL)
// =========================================================

export const localAStar = (startId: number, endId: number, nodes: DBNode[], edges: DBEdge[]): number[] | null => {
  console.log(`[localAStar] Finding path from ${startId} to ${endId}`);
  console.log(`[localAStar] Graph has ${nodes.length} nodes and ${edges.length} edges.`);

  // 1. Build Adjacency List
  const adj = new Map<number, { id: number, cost: number }[]>();
  edges.forEach(e => {
    // Ensure IDs are numbers
    const u = Number(e.node_a_id);
    const v = Number(e.node_b_id);

    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);

    // Find node objects to calculate distance
    const nA = nodes.find(n => n.id === u);
    const nB = nodes.find(n => n.id === v);

    if (!nA || !nB) {
      // console.warn(`[localAStar] Missing node data for edge ${u}-${v}`);
      return;
    }

    const d = getDist(nA, nB);
    adj.get(u)!.push({ id: v, cost: d });
    adj.get(v)!.push({ id: u, cost: d });
  });

  if (!adj.has(startId)) {
    console.error(`[localAStar] Start Node ${startId} has no edges! (Isolated)`);
    return [startId, endId]; // Fallback: Flying path
  }
  if (!adj.has(endId)) {
    console.error(`[localAStar] End Node ${endId} has no edges! (Isolated)`);
    // Fallback: Flying path
    return [startId, endId];
  }

  // 2. Setup A* structures
  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const openSet = new Set<number>();

  // Helper: Heuristic (Euclidean distance to goal)
  const h = (id: number) => {
    const curr = nodes.find(n => n.id === id);
    const target = nodes.find(n => n.id === endId);
    return (curr && target) ? getDist(curr, target) : 0;
  };

  // Initialize
  gScore.set(startId, 0);
  fScore.set(startId, h(startId));
  openSet.add(startId);

  let iterations = 0;
  while (openSet.size > 0) {
    iterations++;
    if (iterations > 5000) {
      console.warn("[localAStar] Too many iterations, aborting.");
      break;
    }

    // Find node in openSet with lowest fScore
    let current = -1;
    let minF = Infinity;
    openSet.forEach(id => {
      const f = fScore.get(id) ?? Infinity;
      if (f < minF) {
        minF = f;
        current = id;
      }
    });

    if (current === -1) break;

    if (current === endId) {
      console.log(`[localAStar] Path found! Steps: ${iterations}`);
      // Reconstruct path
      const path = [current];
      while (cameFrom.has(current)) {
        current = cameFrom.get(current)!;
        path.unshift(current);
      }
      return path;
    }

    openSet.delete(current);

    const neighbors = adj.get(current) || [];
    for (const neighbor of neighbors) {
      const tentativeG = (gScore.get(current) ?? Infinity) + neighbor.cost;
      if (tentativeG < (gScore.get(neighbor.id) ?? Infinity)) {
        cameFrom.set(neighbor.id, current);
        gScore.set(neighbor.id, tentativeG);
        fScore.set(neighbor.id, tentativeG + h(neighbor.id));
        if (!openSet.has(neighbor.id)) {
          openSet.add(neighbor.id);
        }
      }
    }
  }

  console.warn(`[localAStar] No path found between ${startId} and ${endId}. Returning direct line.`);
  return [startId, endId]; // Fallback: Return direct line so visualization shows *something*
};