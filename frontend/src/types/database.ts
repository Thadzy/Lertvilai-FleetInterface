/**
 * DATABASE TYPES
 * * These interfaces mirror the schema defined in Supabase (PostgreSQL).
 * * Use these types throughout the app to ensure Type Safety when handling DB data.
 */

// =========================================================
// 1. ENUMS & CONSTANTS
// =========================================================

/**
 * Defines the functional role of a node in the warehouse.
 * - 'waypoint': Standard intersection or path point.
 * - 'shelf': A storage location (can be a Pickup or Delivery target).
 * - 'inbound': Receiving area (Pickup point).
 * - 'outbound': Shipping area (Delivery point).
 * - 'depot': Robot parking/charging station (must be named '__depot__').
 */
export type NodeType = 'inbound' | 'outbound' | 'shelf' | 'waypoint' | 'depot';

/**
 * Status for Pickup & Delivery requests.
 */
export type PDRequestStatus = 'cancelled' | 'failed' | 'queuing' | 'in_progress' | 'completed';

/**
 * Status for robot assignments.
 */
export type AssignmentStatus = 'cancelled' | 'failed' | 'in_progress' | 'partially_completed' | 'completed';

/**
 * Status for individual tasks.
 */
export type TaskStatus = 'cancelled' | 'failed' | 'on_another_delivery' | 'pickup_en_route' | 'picking_up' | 'delivery_en_route' | 'dropping_off' | 'delivered';

/**
 * Status for robots.
 */
export type RobotStatus = 'offline' | 'idle' | 'inactive' | 'busy';

// =========================================================
// 2. TABLE INTERFACES
// =========================================================

/**
 * Table: public.wh_nodes
 * Represents a physical point on the warehouse floor.
 */
export interface DBNode {
  id: number;          // Primary Key
  graph_id: number;    // Foreign Key -> wh_graphs.id
  x: number;           // X Coordinate (in Meters)
  y: number;           // Y Coordinate (in Meters)
  alias: string;       // Human-readable label (e.g., "Shelf A-01") (DB Column: alias)
  type: NodeType;      // Functional role
  a: number;           // Orientation/Angle (in Degrees, usually 0-360)
  level: number;
}

/**
 * Table: public.wh_edges
 * Represents a valid path between two nodes.
 * Edges are typically bidirectional in this system.
 */
export interface DBEdge {
  id: number;          // Primary Key
  graph_id: number;    // Foreign Key -> wh_graphs.id
  node_a_id: number;   // Start Node ID
  node_b_id: number;   // End Node ID
}

/**
 * Table: public.wh_graphs
 * Represents a specific warehouse layout configuration.
 */
export interface DBGraph {
  id: number;          // Primary Key
  name: string;        // Unique Name (e.g., "warehouse_A")
  map_url: string | null;     // Public URL to the background floorplan image (Supabase Storage)
  map_res: number | null;     // Resolution (Meters per Pixel) - Reserved for future scaling
  created_at: string;  // Timestamp
}

/**
 * Table: public.wh_levels
 * Defines height levels for cells in a graph.
 */
export interface DBLevel {
  id: number;
  level: number;      // Level number (1, 2, 3, ...)
  height: number;      // Height in meters
  graph_id: number;
  created_at: string;
}

/**
 * Table: public.wh_cells
 * Represents a storage cell at a specific node and level/height.
 */
export interface DBCell {
  id: number;
  graph_id: number;
  node_id: number;
  level_id: number | null;  // Either level_id OR height must be set (XOR)
  height: number | null;   // Either level_id OR height must be set (XOR)
  created_at: string;
}

/**
 * Table: public.wh_requests
 * Pickup & Delivery requests from users/WMS.
 */
export interface DBRequest {
  id: number;
  pickup_cell_id: number;
  delivery_cell_id: number;
  status: PDRequestStatus;
  priority: number;    // 0-100
  created_at: string;
}

/**
 * Table: public.wh_robots
 * Robot fleet information.
 */
export interface DBRobot {
  id: number;
  name: string;
  status: RobotStatus;
  endpoint: string;   // URL for robot connection
  capacity: number;    // Number of slots (must be > 0)
  created_at: string;
}

/**
 * Table: public.wh_robot_slots
 * Tracks which requests are being carried by robots.
 */
export interface DBRobotSlot {
  robot_id: number;
  slot: number;       // Slot index (0 to capacity-1)
  request_id: number | null;  // NULL when empty
}

/**
 * Table: public.wh_assignments
 * Robot assignments created from VRP solutions or manual routing.
 */
export interface DBAssignment {
  id: number;
  robot_id: number | null;  // NULL if not yet assigned
  original_seq: any;         // JSON array: [{retrieve: bool, cell_id: number}]
  provider: string;          // 'user', 'user_vrp', 'wms', 'wms_vrp', 'test', 'test_vrp'
  status: AssignmentStatus;
  priority: number;
  created_at: string;
}

/**
 * Table: public.wh_tasks
 * Individual tasks created from assignments.
 */
export interface DBTask {
  id: number;
  cell_id: number;
  retrieve: boolean;   // true: pick from shelf, false: place on shelf
  status: TaskStatus;
  assignment_id: number;
  seq_order: number;  // Order within assignment (0, 1, 2, ...)
  request_id: number | null;
  created_at: string;
}