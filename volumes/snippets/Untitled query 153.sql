/**
 * @function public.wh_set_node_as_depot
 * @description Reassigns an existing node (such as a waypoint or conveyor) to act as the primary depot for a specific graph. 
 * The function updates the coordinates of the existing depot to match the target node, transfers all edge 
 * connections from the target node to the depot, and finally deletes the target node to prevent duplication.
 *
 * @param {bigint} p_graph_id - The unique identifier of the graph context.
 * @param {bigint} p_target_node_id - The unique identifier of the node intended to become the new depot.
 *
 * @returns {void}
 *
 * @throws {Exception} If the existing depot cannot be located within the specified graph.
 * @throws {Exception} If the target node is non-existent.
 * @throws {Exception} If the target node is associated with a different graph ID.
 * @throws {Exception} If the target node type is incompatible (must be 'waypoint' or 'conveyor').
 */
CREATE OR REPLACE FUNCTION public.wh_set_node_as_depot(
  p_graph_id       bigint,
  p_target_node_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_depot_id bigint;
  v_target_type node_type;
  v_target_graph_id bigint;
  v_x real;
  v_y real;
BEGIN
  -- 1. Retrieve the ID of the current depot associated with the provided graph ID
  SELECT id INTO v_depot_id
  FROM public.wh_nodes
  WHERE graph_id = p_graph_id AND type = 'depot';

  IF v_depot_id IS NULL THEN
    RAISE EXCEPTION 'Depot not found for graph %', p_graph_id;
  END IF;

  -- 2. Extract the properties and spatial coordinates of the target node
  SELECT n.type, n.graph_id, nv.x, nv.y
  INTO v_target_type, v_target_graph_id, v_x, v_y
  FROM public.wh_nodes n
  JOIN public.wh_nodes_view nv ON nv.id = n.id
  WHERE n.id = p_target_node_id;

  -- 3. Perform strict validations to ensure data integrity before proceeding with mutations
  IF v_target_graph_id IS NULL THEN
    RAISE EXCEPTION 'Target node % does not exist', p_target_node_id;
  END IF;

  IF v_target_graph_id <> p_graph_id THEN
    RAISE EXCEPTION 'Target node % belongs to graph %, not graph %', p_target_node_id, v_target_graph_id, p_graph_id;
  END IF;

  -- Exit early if the target is already a depot, requiring no further action
  IF v_target_type = 'depot' THEN
    RETURN;
  END IF;

  -- Restrict the conversion to specific node types to maintain graph logic
  IF v_target_type NOT IN ('waypoint', 'conveyor') THEN
    RAISE EXCEPTION 'Only waypoints and conveyors can be set as depot (target is %)', v_target_type;
  END IF;

  -- 4. Update the spatial coordinates of the existing depot to match the target node
  UPDATE public.wh_depot_nodes
  SET x = v_x, y = v_y
  WHERE id = v_depot_id;

  -- 5. Reassign all edges connected to the target node so they now connect to the depot
  -- LEAST and GREATEST are utilized to maintain a consistent ordering of node IDs within the edge definition
  INSERT INTO public.wh_edges (graph_id, node_a_id, node_b_id)
  SELECT
    p_graph_id,
    LEAST(v_depot_id, CASE WHEN node_a_id = p_target_node_id THEN node_b_id ELSE node_a_id END),
    GREATEST(v_depot_id, CASE WHEN node_a_id = p_target_node_id THEN node_b_id ELSE node_a_id END)
  FROM public.wh_edges
  WHERE node_a_id = p_target_node_id OR node_b_id = p_target_node_id
  ON CONFLICT DO NOTHING;

  -- 6. Remove the original target node entirely to finalize the replacement process
  DELETE FROM public.wh_nodes WHERE id = p_target_node_id;
END;
$$;