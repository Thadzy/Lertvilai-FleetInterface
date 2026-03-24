# 📋 Complete TODO Checklist

This checklist covers all requirements from the project specification and identifies what needs to be implemented or fixed.

---

## 🗄️ Database & Schema Setup

### Schema Application
- [ ] Apply `wh_schema_clean_fixed.sql` to Supabase database
- [ ] Verify all tables exist: `wh_graphs`, `wh_nodes`, `wh_edges`, `wh_levels`, `wh_cells`, `wh_requests`, `wh_robots`, `wh_robot_slots`, `wh_assignments`, `wh_tasks`
- [ ] Verify all enum types exist: `node_type`, `pd_request_status`, `assignment_status`, `task_status`, `robot_status`
- [ ] Verify triggers work (auto-create depot, robot slot sync)
- [ ] Test `astar_cost_matrix_by_names()` function with pgRouting

### Sample Data
- [ ] Insert sample graph: `warehouse_A`
- [ ] Insert nodes (15 waypoints, 6 shelves, 1 inbound, 1 outbound, 1 depot)
- [ ] Insert edges (connections between nodes)
- [ ] Insert levels (3 levels: 1.25m, 2.5m, 3.75m)
- [ ] Insert cells (cells for each shelf at each level)

---

## 🏭 Program 1: Fleet Interface

### Tab 1: Graph Editor

#### Current Status: ✅ Mostly Complete
- [x] Load/Save graph data from Supabase
- [x] Upload map background images
- [x] Add/Delete nodes and edges
- [x] Visual editing with ReactFlow
- [x] Node type support (waypoint, shelf, inbound, outbound)

#### Missing Features:
- [ ] **Node Type Selection UI**: Add dropdown/selector when creating nodes
  - [ ] Support all types: `inbound`, `outbound`, `shelf`, `waypoint`, `depot`
  - [ ] Visual distinction (colors/icons) for each type
  - [ ] Prevent manual depot creation (auto-created by schema)
  - [ ] Show depot node in editor (read-only, special styling)

- [ ] **Cell Management**:
  - [ ] UI to create cells for shelf/inbound/outbound nodes
  - [ ] Support both `level_id` (reference to wh_levels) and `height` (direct value)
  - [ ] Show cells in node properties panel
  - [ ] Allow editing cell availability

- [ ] **Level Management**:
  - [ ] UI to create/edit levels for a graph
  - [ ] Display levels in sidebar
  - [ ] Link cells to levels

- [ ] **Node Properties Panel**:
  - [ ] Edit node name, type, position
  - [ ] Edit orientation/angle (`a` field)
  - [ ] Show associated cells
  - [ ] Show connected edges count

- [ ] **Visual Improvements**:
  - [ ] Color-code nodes by type (shelf=cyan, inbound=green, outbound=orange, waypoint=grey, depot=yellow)
  - [ ] Show node labels on map (toggle option)
  - [ ] Better edge visualization (show direction, weight)

---

### Tab 2: Optimization (Task Delegator)

#### Current Status: ⚠️ Partially Complete
- [x] CRUD for Pickup & Delivery requests (`wh_requests`)
- [x] Task selection UI
- [x] VRP Solver integration (mocked)
- [x] Solution visualization
- [x] Preview functionality

#### Missing Features:

- [ ] **Assignment Creation from VRP Solution**:
  - [ ] After VRP solve, create `wh_assignments` records
  - [ ] Store `original_seq` as JSON: `[{retrieve: bool, cell_id: number}]`
  - [ ] Set `provider` field: `'user_vrp'` or `'test_vrp'`
  - [ ] Map routes to specific robots (robot selection UI)
  - [ ] Set assignment `priority` and `status` ('in_progress')

- [ ] **Manual Routing Mode**:
  - [ ] Toggle between "VRP Solve" and "Manual Routing"
  - [ ] UI to manually create assignments without VRP
  - [ ] Drag-and-drop or form-based task sequencing
  - [ ] Set `provider` to `'user'` for manual assignments

- [ ] **Robot Selection**:
  - [ ] Display available robots from `wh_robots` table
  - [ ] Show robot status (idle, busy, offline)
  - [ ] Allow assigning routes to specific robots
  - [ ] Validate robot capacity before assignment

- [ ] **Assignment Management**:
  - [ ] List all assignments (with status, robot, provider)
  - [ ] View assignment details (original_seq, tasks)
  - [ ] Cancel assignments
  - [ ] Retry failed assignments

- [ ] **Task Conversion**:
  - [ ] Convert assignments to `wh_tasks` (or let Fleet Gateway do this)
  - [ ] Create tasks with proper `seq_order`
  - [ ] Link tasks to `wh_requests`

- [ ] **Real VRP API Integration**:
  - [ ] Replace `mockSolveVRP` with real API call
  - [ ] Connect to VRP Broker at `http://127.0.0.1:7779/solve`
  - [ ] Handle API errors and timeouts
  - [ ] Add retry logic for network failures
  - [ ] Show loading states during solve

- [ ] **Solve & Dispatch Option**:
  - [ ] Add "Solve & Dispatch" button (solves and automatically sends to Fleet Controller)
  - [ ] Separate from "Solve" (which only previews)

- [ ] **Request Status Management**:
  - [ ] Update request status: `queuing` → `in_progress` → `completed`
  - [ ] Handle `cancelled` and `failed` statuses
  - [ ] Show status in task list with color coding

---

### Tab 3: Fleet Controller

#### Current Status: ❌ NOT IMPLEMENTED (File is duplicate of GraphEditor)

#### Required Complete Implementation:

- [ ] **MQTT Connection**:
  - [ ] Install and configure MQTT client (package already installed)
  - [ ] Connect to MQTT broker (central server)
  - [ ] Subscribe to robot status topics: `robots/{robot_id}/status`
  - [ ] Subscribe to robot position topics: `robots/{robot_id}/position`
  - [ ] Subscribe to task updates: `robots/{robot_id}/tasks`
  - [ ] Handle connection errors and reconnection

- [ ] **Robot Visualization**:
  - [ ] Display warehouse map (load from current graph)
  - [ ] Show all nodes (waypoints, shelves, etc.)
  - [ ] Display robot positions as moving icons
  - [ ] Update positions in real-time via MQTT
  - [ ] Color-code robots by status (idle=green, busy=blue, offline=red)
  - [ ] Show robot ID/name labels
  - [ ] Show robot current task/assignment

- [ ] **Robot Status Panel**:
  - [ ] List all robots from `wh_robots` table
  - [ ] Show robot status: `offline`, `idle`, `inactive`, `busy` (schema uses `busy`, not `on_duty`)
  - [ ] Display current assignment ID
  - [ ] Show battery level (if available via MQTT)
  - [ ] Show current location (node name)
  - [ ] Show robot capacity and occupied slots

- [ ] **Control Functions**:
  - [ ] **Pause Button**: Pause current task (send MQTT command)
  - [ ] **Stop Button**: Stop and return to depot (send MQTT command)
  - [ ] **Resume Button**: Resume paused task
  - [ ] **Emergency Stop**: Immediate stop for all robots
  - [ ] Confirmation dialogs for destructive actions

- [ ] **Task Monitoring**:
  - [ ] Display active tasks from `wh_tasks` table
  - [ ] Filter by robot, assignment, or status
  - [ ] Show task status: `pickup_en_route`, `picking_up`, `delivery_en_route`, `dropping_off`, `delivered`
  - [ ] Show task progress (if available)
  - [ ] Update task status in real-time

- [ ] **Assignment Monitoring**:
  - [ ] Display active assignments
  - [ ] Show assignment status: `in_progress`, `partially_completed`, `completed`
  - [ ] Show assignment progress (tasks completed / total tasks)
  - [ ] Allow canceling assignments

- [ ] **Real-time Updates**:
  - [ ] Poll database for robot/task updates (or use Supabase realtime)
  - [ ] Update UI when MQTT messages arrive
  - [ ] Show last update timestamp

- [ ] **Files to Create**:
  - [ ] `src/hooks/useMQTT.ts` - MQTT connection hook
  - [ ] `src/hooks/useRobots.ts` - Robot data management
  - [ ] `src/hooks/useAssignments.ts` - Assignment monitoring
  - [ ] `src/components/FleetController.tsx` - Complete rewrite (not GraphEditor copy)

---

## 🤖 Program 2: Robot Interface

### Tab 1: Mobile Base

#### Current Status: ⚠️ UI Complete, Backend Missing
- [x] Open-loop mode UI (DirectionPad, ParameterInput)
- [x] Distance and speed inputs
- [x] Execute button

#### Missing Features:

- [ ] **Open-loop Mode - ROS Integration**:
  - [ ] Install ROS client library (`roslibjs` or `rosnodejs`)
  - [ ] Connect to ROS bridge (WebSocket)
  - [ ] Create ROS Action client for `OpenLoopMove.action`
  - [ ] Send action with parameters: `distance`, `speed`
  - [ ] Display feedback: `moved_distance`, `duration`, `progress`
  - [ ] Handle action cancellation
  - [ ] Show action status (active, succeeded, aborted)

- [ ] **Closed-loop Mode (QRNavigate)**:
  - [ ] Add toggle/switch between Open-loop and Closed-loop modes
  - [ ] Load graph representation from database (via API)
  - [ ] Display graph in UI (waypoints as selectable points)
  - [ ] Build waypoint sequence UI:
    - [ ] Drag-and-drop waypoint selection
    - [ ] Form-based sequence builder
    - [ ] Preview sequence path
  - [ ] Create ROS Action client for `QRNavigate.action`
  - [ ] Send action with `Waypoint[]` array:
    - [ ] `movement` (FORWARD=0, LEFT=1, RIGHT=2, BACKWARD=3)
    - [ ] `distance` (meters)
  - [ ] Display feedback: `index`, `target_waypoint`, `progress`
  - [ ] Show current waypoint in sequence

- [ ] **Status Subscription**:
  - [ ] Subscribe to QR Code topic (get robot position)
  - [ ] Display: ID, x, y, angle
  - [ ] Subscribe to speed/velocity topic
  - [ ] Display current speed
  - [ ] Subscribe to other status topics (battery, errors, etc.)
  - [ ] Update UI in real-time

- [ ] **Graph Representation**:
  - [ ] Fetch graph from Supabase (or via API)
  - [ ] Display waypoints on map
  - [ ] Allow selecting waypoints for sequence
  - [ ] Show current robot position on map

- [ ] **Files to Create**:
  - [ ] `src/lib/rosClient.ts` - ROS connection manager
  - [ ] `src/hooks/useROSActions.ts` - ROS Action calls
  - [ ] `src/hooks/useROSSubscriptions.ts` - ROS topic subscriptions
  - [ ] `src/components/MobileBase/ClosedLoopMode.tsx` - Closed-loop UI
  - [ ] Update `MobileBaseTab.tsx` with real functionality

---

### Tab 2: Piggyback

#### Current Status: ❌ NOT IMPLEMENTED (Placeholder only)

#### Required Complete Implementation:

- [ ] **Independent Axis Control**:
  - [ ] **Lift Control**:
    - [ ] Input field for height (float64)
    - [ ] ROS Service client: `std_msgs/Float64`
    - [ ] Send height command
    - [ ] Display current height (if subscribed)
  
  - [ ] **Turntable Control**:
    - [ ] Input field for angle (float64)
    - [ ] ROS Service client: `std_msgs/Float64`
    - [ ] Send angle command
    - [ ] Display current angle (if subscribed)
  
  - [ ] **Insert Control**:
    - [ ] Input field for distance (float64)
    - [ ] ROS Service client: `std_msgs/Float64`
    - [ ] Send distance command
    - [ ] Display current position (if subscribed)
  
  - [ ] **Hook Control**:
    - [ ] Toggle button (Bool)
    - [ ] ROS Service client: `std_msgs/Bool`
    - [ ] Send hook up/down command
    - [ ] Display current state

- [ ] **Sequence Control (TransportTote Action)**:
  - [ ] **Action Client**:
    - [ ] Create ROS Action client for `TransportTote.action`
    - [ ] Handle action feedback and result
  
  - [ ] **Sequence Builder UI**:
    - [ ] Form-based sequence builder
    - [ ] Parameters:
      - [ ] `robot_level` (int8) - dropdown (0 = lowest)
      - [ ] `lift_height` (float64) - input
      - [ ] `turntable_angle` (float64) - input
      - [ ] `is_retrieving` (bool) - toggle (true: shelf→robot, false: robot→shelf)
      - [ ] `expected_id` (string) - optional input
    - [ ] Preview sequence
    - [ ] Execute button
  
  - [ ] **Feedback Display**:
    - [ ] `state` enum: PICKING_FROM_SHELF, PLACING_ON_SHELF, PICKING_FROM_ROBOT, PLACING_ON_ROBOT
    - [ ] `moving_component` enum: LIFT, TURNTABLE, INSERT, HOOK
    - [ ] `progress` (float64) - progress bar
    - [ ] Real-time status updates

- [ ] **UI Layout**:
  - [ ] Split view: Independent controls (left) + Sequence builder (right)
  - [ ] Visual indicators for each axis
  - [ ] Status panel showing current state
  - [ ] Error handling and display

- [ ] **Files to Create**:
  - [ ] `src/components/Piggyback/IndependentControl.tsx`
  - [ ] `src/components/Piggyback/SequenceBuilder.tsx`
  - [ ] `src/components/Piggyback/TransportToteAction.tsx`
  - [ ] Complete rewrite of `PiggybackTab.tsx`

---

## 🔌 Backend Integration

### VRP Solver

#### Current Status: ⚠️ Mocked
- [x] Mock solver in `solverUtils.ts`
- [x] Distance matrix generation
- [x] Task formatting

#### Missing:
- [ ] **Real API Integration**:
  - [ ] Uncomment and fix `solveVRP` function in `solverUtils.ts`
  - [ ] Configure VRP Broker endpoint (default: `http://127.0.0.1:7779/solve`)
  - [ ] Add environment variable for endpoint
  - [ ] Handle API errors (network, timeout, invalid response)
  - [ ] Add retry logic (exponential backoff)
  - [ ] Add request timeout (e.g., 30 seconds)
  - [ ] Validate response format
  - [ ] Log API calls for debugging

- [ ] **Error Handling**:
  - [ ] Show user-friendly error messages
  - [ ] Handle "solver unavailable" gracefully
  - [ ] Fallback to mock solver in development mode

---

### Fleet Gateway

#### Current Status: ❌ NOT IMPLEMENTED

#### Required (Backend Service - Separate from Frontend):

- [ ] **Backend Service Setup**:
  - [ ] Choose technology (Node.js, Python, etc.)
  - [ ] Set up project structure
  - [ ] Connect to Supabase database
  - [ ] Set up MQTT client for robot communication

- [ ] **Assignment Monitoring**:
  - [ ] Poll `wh_assignments` table for new assignments
  - [ ] Or use Supabase realtime subscriptions
  - [ ] Filter by status: `in_progress` or newly created

- [ ] **Task Creation**:
  - [ ] Convert assignments to tasks
  - [ ] Parse `original_seq` JSON
  - [ ] Create `wh_tasks` records with proper `seq_order`
  - [ ] Link tasks to `wh_requests`

- [ ] **Robot Communication**:
  - [ ] Send tasks to robots via MQTT/ROS
  - [ ] Format: `WarehouseAction` message
  - [ ] Handle robot acknowledgments
  - [ ] Retry failed sends

- [ ] **Status Updates**:
  - [ ] Receive task status updates from robots
  - [ ] Update `wh_tasks.status` in database
  - [ ] Update `wh_assignments.status` when all tasks complete
  - [ ] Update `wh_requests.status` when delivered

- [ ] **Robot Management**:
  - [ ] Monitor `wh_robots` table
  - [ ] Update `wh_robot_slots` when tasks assigned/completed
  - [ ] Handle robot capacity changes

- [ ] **Priority Handling**:
  - [ ] Process assignments by priority (lowest first)
  - [ ] Process tasks by `seq_order` (lowest first)
  - [ ] Skip cancelled/failed tasks

---

## 🧪 Testing & Quality

### Unit Tests
- [ ] Test distance matrix generation
- [ ] Test task formatting for solver
- [ ] Test assignment creation
- [ ] Test task conversion

### Integration Tests
- [ ] Test VRP Solver API connection
- [ ] Test MQTT connection and messaging
- [ ] Test ROS Action calls
- [ ] Test database operations (CRUD)

### UI/UX Improvements
- [ ] Add loading states for all async operations
- [ ] Add error messages/toasts
- [ ] Add confirmation dialogs for destructive actions
- [ ] Improve mobile responsiveness
- [ ] Add keyboard shortcuts
- [ ] Add tooltips for complex features

### Performance
- [ ] Optimize distance matrix calculation (move to backend if > 200 nodes)
- [ ] Implement caching for graph data
- [ ] Reduce unnecessary re-renders
- [ ] Optimize MQTT message handling

---

## 📝 Documentation

- [ ] Update README with setup instructions
- [ ] Document MQTT topic structure
- [ ] Document ROS Action/Service interfaces
- [ ] Document API endpoints
- [ ] Add code comments for complex logic
- [ ] Create user guide for each tab

---

## 🚀 Deployment

- [ ] Set up environment variables
- [ ] Configure Supabase connection
- [ ] Configure MQTT broker URL
- [ ] Configure ROS bridge URL
- [ ] Configure VRP Solver endpoint
- [ ] Build production bundle
- [ ] Deploy frontend
- [ ] Deploy Fleet Gateway backend service

---

## ✅ Summary by Priority

### 🔴 Critical (Must Have)
1. Fleet Controller - Complete rewrite with MQTT
2. Assignment system - Create assignments from VRP solutions
3. Real VRP API integration
4. Robot Interface - ROS integration for Mobile Base
5. Piggyback Tab - Complete implementation

### 🟡 High Priority
1. Graph Editor - Node type selection and cell management
2. Manual routing mode in Optimization
3. Robot selection UI
4. Task status monitoring

### 🟢 Medium Priority
1. Level management UI
2. Assignment management UI
3. Real-time updates with Supabase realtime
4. Error handling and user feedback

### 🔵 Low Priority
1. Performance optimizations
2. Unit tests
3. Documentation
4. UI polish

---

**Last Updated**: Based on project specification and current codebase analysis
