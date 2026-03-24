import { type DBNode } from '../types/database';

/**
 * VRP API Client
 *
 * Communicates exclusively with the C++ VRP server proxied via Vite at /api/cpp-vrp.
 * The C++ server (Crow + OR-Tools, port 18080) handles cost-matrix computation
 * internally using the warehouse graph stored in PostgreSQL.
 *
 * Python VRP fallback has been removed — all routing must go through the C++ server.
 */

/** Proxy path to the C++ VRP server (configured in vite.config.ts → /api/cpp-vrp → :18080). */
const CPP_VRP_URL = '/api/cpp-vrp';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Request payload sent to the C++ VRP solver.
 *
 * @property graph_id           - ID of the warehouse graph in PostgreSQL.
 * @property num_vehicles       - Number of robots available for assignment.
 * @property pickups_deliveries - Array of pickup/delivery node ID pairs.
 * @property robot_locations    - Optional array of starting node IDs per robot.
 * @property vehicle_capacity   - Optional maximum number of tasks per robot.
 */
export interface VrpRequest {
    graph_id: number;
    num_vehicles: number;
    pickups_deliveries: { id?: number; pickup: number; delivery: number }[];
    robot_locations?: number[];
    vehicle_capacity?: number;
}

/** Raw response envelope returned by the C++ VRP server. */
interface CppVrpResponse {
    status: 'success' | 'error';
    data?: { paths: number[][] };
    error?: { type: string; message: string };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Submit a VRP solve request to the C++ server and return per-vehicle node paths.
 *
 * Builds an `application/x-www-form-urlencoded` body as required by the Crow
 * HTTP server and deserialises the JSON response.
 *
 * @param req - The VRP request parameters.
 * @returns   A 2-D array where each inner array is the ordered node IDs for one vehicle.
 * @throws    Error if the server returns an error status or an unexpected response shape.
 */
async function solveCpp(req: VrpRequest): Promise<number[][]> {
    const formData = new URLSearchParams();
    formData.append('graph_id', String(req.graph_id));
    formData.append('num_vehicles', String(req.num_vehicles));

    // Serialise pickups_deliveries as [[pickup, delivery], ...] array
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
        // 30-second hard deadline — OR-Tools can be slow on large instances
        signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`C++ VRP server HTTP ${res.status}: ${text}`);
    }

    const json: CppVrpResponse = await res.json();

    if (json.status === 'error' || !json.data) {
        throw new Error(json.error?.message ?? 'C++ VRP solver returned an error with no message');
    }

    return json.data.paths;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Solve a Vehicle Routing Problem using the C++ VRP server.
 *
 * This is the single entry point for all route-optimisation calls in the
 * frontend. If the C++ server is unreachable or returns an error the
 * exception is propagated to the caller — there is no silent fallback.
 *
 * The `dbNodes` and `distanceMatrix` parameters are accepted for API
 * compatibility but are not used; the C++ server derives costs from the DB.
 *
 * @param req            - VRP problem definition (graph, vehicles, tasks).
 * @param _dbNodes       - Unused. Kept for call-site compatibility.
 * @param _distanceMatrix - Unused. Kept for call-site compatibility.
 * @returns An object containing the per-vehicle `paths` (node ID arrays)
 *          and `server: 'cpp'` indicating which backend was used.
 * @throws  Error if the C++ server is unavailable or returns no solution.
 */
export async function solveVRP(
    req: VrpRequest,
    _dbNodes?: DBNode[],
    _distanceMatrix?: number[][],
): Promise<{ paths: number[][]; server: 'cpp' }> {
    console.log(`[VRP] Submitting solve request to C++ server (${CPP_VRP_URL})...`);

    // Any exception from solveCpp is intentionally re-thrown so the caller
    // (e.g. the dispatch modal) can display a meaningful error to the user.
    const paths = await solveCpp(req);

    console.log(`[VRP] C++ server returned ${paths.length} route(s)`);
    return { paths, server: 'cpp' };
}

/**
 * Check whether the C++ VRP server is reachable via its /health endpoint.
 *
 * The `python` field is always `false` as the Python server has been removed.
 *
 * @returns `{ cpp: boolean; python: false }`
 */
export async function checkVrpServers(): Promise<{ cpp: boolean; python: false }> {
    let cpp = false;
    try {
        const res = await fetch(`${CPP_VRP_URL}/health`, {
            signal: AbortSignal.timeout(2000),
        });
        cpp = res.ok;
    } catch {
        cpp = false;
    }
    return { cpp, python: false };
}
