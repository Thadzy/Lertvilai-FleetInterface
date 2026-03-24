import { type DBNode } from '../types/database';

/**
 * VRP API Client
 * Supports two backends:
 * 1. C++ VRP Server (Senior's) on port 18080 — preferred, handles cost matrix internally
 * 2. Python VRP Server on port 7779 — fallback, requires frontend to compute distance matrix
 */

const CPP_VRP_URL = '/api/cpp-vrp';
const PY_VRP_URL = '/api/vrp';

// --- C++ Server Types ---

/**
 * Request payload for the VRP solver.
 * Contains the graph ID, vehicle count, and an array of pickup-delivery tasks.
 */
export interface VrpRequest {
    graph_id: number;
    num_vehicles: number;
    pickups_deliveries: { id?: number; pickup: number; delivery: number }[];
    robot_locations?: number[];
    vehicle_capacity?: number;
}

interface CppVrpResponse {
    status: 'success' | 'error';
    data?: { paths: number[][] };
    error?: { type: string; message: string };
}

// --- Python Server Types ---

interface PyVrpRequest {
    matrix: number[][];
    requests: { pickup_index: number; delivery_index: number }[];
    vehicle_count: number;
    depot_index: number;
}

interface PyVrpResponse {
    status: string;
    total_distance?: number;
    wall_time_ms?: number;
    routes?: { vehicle_id: number; nodes: number[]; distance: number }[];
    message?: string;
    error?: string;
}

/**
 * Try the C++ VRP server first. Returns paths for each vehicle.
 */
async function solveCpp(req: VrpRequest): Promise<number[][]> {
    const formData = new URLSearchParams();
    formData.append('graph_id', String(req.graph_id));
    formData.append('num_vehicles', String(req.num_vehicles));
    const pdArray = req.pickups_deliveries.map(pd => [pd.pickup, pd.delivery]);
    formData.append('pickups_deliveries', JSON.stringify(pdArray));

    if (req.robot_locations && req.robot_locations.length > 0) {
        formData.append('robot_locations', JSON.stringify(req.robot_locations));
    }
    if (req.vehicle_capacity && req.vehicle_capacity > 0) {
        formData.append('vehicle_capacity', String(req.vehicle_capacity));
    }

    const res = await fetch(`${CPP_VRP_URL}/solve_id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
        signal: AbortSignal.timeout(30000),
    });

    const json: CppVrpResponse = await res.json();

    if (json.status === 'error' || !json.data) {
        throw new Error(json.error?.message || 'C++ VRP solver error');
    }

    return json.data.paths;
}

/**
 * Fallback: Python VRP server. Needs a precomputed distance matrix.
 */
async function solvePython(
    matrix: number[][],
    requests: { pickup_index: number; delivery_index: number }[],
    numVehicles: number,
    depotIndex: number
): Promise<number[][]> {
    const body: PyVrpRequest = {
        matrix,
        requests,
        vehicle_count: numVehicles,
        depot_index: depotIndex
    };

    const res = await fetch(`${PY_VRP_URL}/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`[VRP] Python solver returned HTTP ${res.status}:`, errorText);
        throw new Error(`Python solver error (${res.status}): ${errorText}`);
    }

    const json: PyVrpResponse = await res.json();

    if (json.status !== "feasible" || !json.routes) {
        throw new Error(json.message || json.error || 'Python VRP solver: no feasible solution');
    }

    return json.routes.map(r => r.nodes);
}

/**
 * Main solver entry point.
 * Tries C++ server first, falls back to Python server with a locally-built matrix.
 */
export async function solveVRP(
    req: VrpRequest,
    dbNodes: DBNode[],
    distanceMatrix?: number[][],
): Promise<{ paths: number[][]; server: 'cpp' | 'python' }> {

    // Try C++ server first
    try {
        console.log(`[VRP] Trying C++ server (${CPP_VRP_URL})...`);
        const paths = await solveCpp(req);
        console.log(`[VRP] ✅ C++ server returned ${paths.length} routes`);
        return { paths, server: 'cpp' };
    } catch (cppErr) {
        console.warn(`[VRP] C++ server unavailable:`, cppErr);
    }

    // Fallback to Python server
    if (distanceMatrix) {
        try {
            console.log(`[VRP] Trying Python server (${PY_VRP_URL})...`);

            // Full index map: node ID → full matrix index
            const idToFullIdx = new Map<number, number>();
            dbNodes.forEach((n, i) => idToFullIdx.set(n.id, i));

            const depotFullIdx = dbNodes.findIndex(n => n.type === 'depot');
            const depotNodeId = dbNodes[depotFullIdx >= 0 ? depotFullIdx : 0].id;

            // Collect only the nodes that matter: depot + all pickup + delivery nodes
            const requiredNodeIds = new Set<number>([depotNodeId]);
            for (const pd of req.pickups_deliveries) {
                requiredNodeIds.add(pd.pickup);
                requiredNodeIds.add(pd.delivery);
            }

            // Build ordered list of required nodes (depot first)
            const requiredNodes = [
                dbNodes.find(n => n.id === depotNodeId)!,
                ...dbNodes.filter(n => n.id !== depotNodeId && requiredNodeIds.has(n.id)),
            ];

            // Build reduced N×N matrix using shortest paths from the full matrix
            const reducedMatrix = requiredNodes.map(rowNode => {
                const rowIdx = idToFullIdx.get(rowNode.id)!;
                return requiredNodes.map(colNode => {
                    const colIdx = idToFullIdx.get(colNode.id)!;
                    return distanceMatrix[rowIdx][colIdx];
                });
            });

            // Map required node IDs to their index in the reduced matrix
            const idToReducedIdx = new Map<number, number>();
            requiredNodes.forEach((n, i) => idToReducedIdx.set(n.id, i));

            // Build pickup/delivery pairs using reduced indices
            const requests: { pickup_index: number; delivery_index: number }[] = [];
            for (const pd of req.pickups_deliveries) {
                const u = idToReducedIdx.get(pd.pickup);
                const v = idToReducedIdx.get(pd.delivery);
                if (u !== undefined && v !== undefined) {
                    requests.push({ pickup_index: u, delivery_index: v });
                } else {
                    console.warn(`[VRP] Could not map node IDs ${pd.pickup} or ${pd.delivery} to reduced index`);
                }
            }

            const depotReducedIdx = 0; // depot is always first in requiredNodes

            console.log(`[VRP] Reduced matrix: ${requiredNodes.length} nodes (from ${dbNodes.length}):`, requiredNodes.map(n => n.alias || n.id));

            const routeIdxPaths = await solvePython(reducedMatrix, requests, req.num_vehicles, depotReducedIdx);

            // Map reduced indices back to real node IDs
            const paths = routeIdxPaths.map(r => r.map(reducedIdx => requiredNodes[reducedIdx].id));

            console.log(`[VRP] ✅ Python server returned ${paths.length} routes`);
            return { paths, server: 'python' };
        } catch (pyErr) {
            console.error(`[VRP] Python server also failed:`, pyErr);
            throw new Error(`Both VRP servers failed. Make sure at least one is running:\n• C++ server: docker compose up (in vrp_server/)\n• Python server: python main.py (in Services/vrp_server/)`);
        }
    }

    throw new Error(
        'C++ VRP server is not running. Start it with: docker compose up (in vrp_server/)\n' +
        'Or start the Python server: python main.py (in Services/vrp_server/)'
    );
}

/**
 * Check which VRP server is available.
 */
export async function checkVrpServers(): Promise<{ cpp: boolean; python: boolean }> {
    const check = async (url: string): Promise<boolean> => {
        try {
            const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
            return res.ok;
        } catch {
            return false;
        }
    };

    const [cpp, python] = await Promise.all([check(CPP_VRP_URL), check(PY_VRP_URL)]);
    return { cpp, python };
}
