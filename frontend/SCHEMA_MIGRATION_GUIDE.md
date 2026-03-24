# 📋 Schema Migration Guide

## Current Situation

You have an **old schema** with:
- ✅ `pd_pairs` table (old)
- ✅ `charger` node type (old)
- ❌ Missing: `wh_requests`, `wh_assignments`, `wh_tasks`, `wh_robots`, `wh_robot_slots`
- ❌ Missing: Triggers (depot auto-create, robot slot sync)
- ❌ Missing: Distance matrix function

## What You Need to Do

### Step 1: Run Migration Script ⚠️

**File**: `MIGRATION_TO_SPEC_SCHEMA.sql`

This script will:
1. ✅ Add missing enum types (`pd_request_status`, `assignment_status`, `task_status`, `robot_status`)
2. ✅ Add `depot` to `node_type` enum
3. ✅ Create missing tables (`wh_requests`, `wh_robots`, `wh_robot_slots`, `wh_assignments`, `wh_tasks`)
4. ✅ Migrate data from `pd_pairs` → `wh_requests` (keeps your existing data!)
5. ✅ Add triggers (depot auto-create, robot slot sync)
6. ✅ Create distance matrix function (`astar_cost_matrix_by_names`)
7. ✅ Create depot nodes for existing graphs

**⚠️ Important**: This script is **SAFE** - it won't delete your existing data!

**How to run**:
1. Open Supabase Dashboard → SQL Editor
2. Copy entire `MIGRATION_TO_SPEC_SCHEMA.sql` file
3. Paste and run
4. Check for errors (should be none)

---

### Step 2: Verify Migration ✅

**File**: `VERIFY_SCHEMA.sql`

Run this to check:
- ✅ All 10 tables exist
- ✅ All 5 enum types exist
- ✅ Triggers work (depot auto-create, robot slots)
- ✅ Distance matrix function exists
- ✅ Data migrated correctly

**How to run**:
1. Open Supabase Dashboard → SQL Editor
2. Copy entire `VERIFY_SCHEMA.sql` file
3. Paste and run
4. Check all statuses show ✅

---

### Step 3: Test Triggers 🔧

#### Test Depot Auto-Create:
```sql
-- Create a new graph
INSERT INTO public.wh_graphs (name, map_url, map_res)
VALUES ('warehouse_B', null, 0.05)
RETURNING id;

-- Check if depot was auto-created
SELECT id, name, type 
FROM public.wh_nodes 
WHERE graph_id = (SELECT id FROM public.wh_graphs WHERE name = 'warehouse_B')
AND type = 'depot';
-- Should return 1 row with name = '__depot__'
```

#### Test Robot Slot Sync:
```sql
-- Create a robot
INSERT INTO public.wh_robots (name, status, endpoint, capacity)
VALUES ('robot_1', 'idle', 'mqtt://test', 5)
RETURNING id;

-- Check if slots were auto-created
SELECT robot_id, slot, request_id
FROM public.wh_robot_slots
WHERE robot_id = (SELECT id FROM public.wh_robots WHERE name = 'robot_1')
ORDER BY slot;
-- Should return 5 rows: slots 0, 1, 2, 3, 4
```

---

### Step 4: Test Distance Matrix Function 📊

**Prerequisites**: You need `warehouse_A` with nodes and edges inserted.

```sql
-- Test the function
SELECT * 
FROM public.astar_cost_matrix_by_names(
  'warehouse_A',
  ARRAY['s_1','s_5','s_6','i_1','o_1'],
  false,  -- undirected
  5       -- heuristic
);
```

**Expected**: Returns a matrix of shortest path costs between nodes.

**If you get an error**: Make sure pgRouting extension is installed:
```sql
CREATE EXTENSION IF NOT EXISTS pgrouting;
```

---

### Step 5: Verify Sample Data 📦

Your existing data should already be there, but verify:

```sql
-- Check warehouse_A exists
SELECT * FROM public.wh_graphs WHERE name = 'warehouse_A';

-- Check nodes (should have 23: 15 waypoints + 6 shelves + 1 inbound + 1 outbound + 1 depot)
SELECT type, COUNT(*) 
FROM public.wh_nodes n
JOIN public.wh_graphs g ON g.id = n.graph_id
WHERE g.name = 'warehouse_A'
GROUP BY type;

-- Check edges (should have ~25)
SELECT COUNT(*) 
FROM public.wh_edges e
JOIN public.wh_graphs g ON g.id = e.graph_id
WHERE g.name = 'warehouse_A';

-- Check levels (should have 3)
SELECT * FROM public.wh_levels l
JOIN public.wh_graphs g ON g.id = l.graph_id
WHERE g.name = 'warehouse_A'
ORDER BY level;

-- Check cells (should have 18: 6 shelves × 3 levels)
SELECT COUNT(*) 
FROM public.wh_cells c
JOIN public.wh_graphs g ON g.id = c.graph_id
WHERE g.name = 'warehouse_A';
```

---

## Checklist ✅

After running migration, verify:

- [ ] All 10 tables exist: `wh_graphs`, `wh_nodes`, `wh_edges`, `wh_levels`, `wh_cells`, `wh_requests`, `wh_robots`, `wh_robot_slots`, `wh_assignments`, `wh_tasks`
- [ ] All 5 enum types exist: `node_type`, `pd_request_status`, `assignment_status`, `task_status`, `robot_status`
- [ ] Depot nodes exist for all graphs (check with verification query)
- [ ] Robot slot trigger works (create robot, check slots auto-created)
- [ ] Distance matrix function exists and works
- [ ] Data migrated from `pd_pairs` to `wh_requests` (check counts match)
- [ ] Sample data (`warehouse_A`) still exists

---

## Troubleshooting 🔧

### Error: "enum value already exists"
- The enum value already exists, skip it. The script uses `IF NOT EXISTS` checks.

### Error: "relation already exists"
- The table already exists, skip it. The script uses `CREATE TABLE IF NOT EXISTS`.

### Error: "function pgr_aStarCostMatrix does not exist"
- Install pgRouting extension:
  ```sql
  CREATE EXTENSION IF NOT EXISTS pgrouting;
  ```

### Error: "depot cannot be deleted"
- This is correct! Depot nodes are protected by triggers. You cannot delete them.

### Error: "Cannot shrink robot capacity"
- A robot's capacity cannot be reduced if slots are occupied. Clear slots first:
  ```sql
  UPDATE public.wh_robot_slots 
  SET request_id = NULL 
  WHERE robot_id = <robot_id> AND slot >= <new_capacity>;
  ```

---

## Next Steps 🚀

After migration is complete:

1. ✅ Update your code to use `wh_requests` instead of `pd_pairs`
2. ✅ Test Graph Editor with depot nodes
3. ✅ Test Optimization tab with new `wh_requests` table
4. ✅ Implement assignment system (create assignments from VRP solutions)

---

## Files Created

1. **`MIGRATION_TO_SPEC_SCHEMA.sql`** - Main migration script (run this first)
2. **`VERIFY_SCHEMA.sql`** - Verification queries (run after migration)
3. **`SCHEMA_MIGRATION_GUIDE.md`** - This guide

---

**Questions?** Check the verification script output - it will tell you what's missing!
