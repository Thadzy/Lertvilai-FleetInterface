import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export interface Task {
  id: number;
  pickup_cell_id: number;
  delivery_cell_id: number;
  pickup_name: string;
  delivery_name: string;
  status: 'queuing' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
  priority: number;
  queued_at: string;
}

export interface Location {
  cell_id: number;
  node_name: string;
  level: number;
  node_id: number;
}

export const useTasks = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);

  // --- 1. LOCAL STORAGE PERSISTENCE ---

  // Load tasks from Local Storage on mount
  useEffect(() => {
    const savedTasks = localStorage.getItem('local_vrp_tasks');
    if (savedTasks) {
      try {
        setTasks(JSON.parse(savedTasks));
      } catch (e) {
        console.error("Failed to parse local tasks", e);
      }
    }
  }, []);

  // Save tasks to Local Storage whenever they change
  useEffect(() => {
    localStorage.setItem('local_vrp_tasks', JSON.stringify(tasks));
  }, [tasks]);


  // --- 2. FETCH LOCATIONS (Real DB) ---

  const fetchLocations = async () => {
    try {
      // Use wh_cell_nodes based on previous verification that it works
      const { data, error } = await supabase
        .from('wh_cell_nodes')
        .select(`
          id,
          level_id,
          level_data:wh_levels!level_id (alias),
          node:wh_nodes!id (alias)
        `);

      if (error) throw error;

      if (data) {
        const formattedLocations = data.map((d: any) => {
          let levelVal = 1;
          // Try to parse level alias as number (e.g. "L1" -> 1, "1" -> 1)
          if (d.level_data?.alias) {
            const match = d.level_data.alias.match(/\d+/);
            if (match) levelVal = parseInt(match[0]);
          }

          return {
            cell_id: d.id, // wh_cell_nodes.id IS the node_id (1:1 relation)
            node_name: d.node?.alias || `Node ${d.id}`,
            level: levelVal,
            node_id: d.id
          };
        });
        setLocations(formattedLocations);
        console.log("Locations fetched (Local Mode):", formattedLocations);
      }
    } catch (err) {
      console.error('Error fetching locations:', err);
    } finally {
      setLoading(false);
    }
  };

  // --- 3. LOCAL TASK MANAGEMENT ---

  const fetchTasks = async () => {
    // No-op for local tasks, they are already in state.
    // Just re-fetching locations to ensure they are fresh.
    await fetchLocations();
  };

  const addTask = async (pickupCellId: number, deliveryCellId: number) => {
    const pickupLoc = locations.find(l => l.cell_id === pickupCellId);
    const deliveryLoc = locations.find(l => l.cell_id === deliveryCellId);

    if (!pickupLoc || !deliveryLoc) {
      alert("Invalid locations selected");
      return false;
    }

    const newTask: Task = {
      id: Date.now(), // Generate a local ID
      pickup_cell_id: pickupCellId,
      delivery_cell_id: deliveryCellId,
      pickup_name: pickupLoc.node_name,
      delivery_name: deliveryLoc.node_name,
      status: 'queuing',
      priority: 1,
      queued_at: new Date().toISOString()
    };

    setTasks(prev => [newTask, ...prev]);
    return true; // Simulate success
  };

  const deleteTask = async (taskId: number) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
    return true;
  };

  // Initialize
  useEffect(() => {
    fetchLocations();
  }, []);

  return {
    tasks,
    locations,
    loading,
    addTask,
    deleteTask,
    refresh: fetchTasks
  };
};