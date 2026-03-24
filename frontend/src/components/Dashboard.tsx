import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, LayoutGrid, MoreVertical,
  Clock, HardDrive,
  Truck, Activity, Settings,
  LogOut, Bell, ChevronRight, Boxes
} from 'lucide-react';

import { supabase } from '../lib/supabaseClient';
import type { DBGraph, DBNode, DBEdge, DBRobot } from '../types/database';
import ThemeToggle from './ThemeToggle';




// --- SUB-COMPONENT: LIVE GRAPH PREVIEW ---
// Renders a mini SVG map of nodes & edges
const GraphPreview: React.FC<{ graphId: number, bgUrl: string | null }> = ({ graphId, bgUrl }) => {
  const [nodes, setNodes] = useState<DBNode[]>([]);
  const [edges, setEdges] = useState<DBEdge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      const { data: nData } = await supabase.from('wh_nodes_view').select('id, x, y, type').eq('graph_id', graphId);
      const { data: eData } = await supabase.from('wh_edges_view').select('node_a_id, node_b_id').eq('graph_id', graphId);

      if (nData) setNodes(nData as DBNode[]);
      if (eData) setEdges(eData as DBEdge[]);
      setLoading(false);
    };
    fetchData();
  }, [graphId]);

  const viewBox = useMemo(() => {
    if (nodes.length === 0) return "0 0 800 600";
    const xs = nodes.map(n => n.x * 100);
    const ys = nodes.map(n => n.y * 100);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(maxX - minX, 100);
    const height = Math.max(maxY - minY, 100);
    const padding = 100;
    return `${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`;
  }, [nodes]);

  const getNode = (id: number) => nodes.find(n => n.id === id);

  if (loading) return <div className="w-full h-full bg-[#1e1e20] animate-pulse" />;

  return (
    <div className="w-full h-full relative overflow-hidden bg-[#18181b]">
      {bgUrl && (
        <img
          src={bgUrl}
          alt="Map Bg"
          className="absolute inset-0 w-full h-full object-cover opacity-20 blur-[1px]"
        />
      )}
      <svg
        viewBox={viewBox}
        className="w-full h-full absolute inset-0 pointer-events-none"
        preserveAspectRatio="xMidYMid meet"
      >
        {edges.map((e, i) => {
          const nA = getNode(e.node_a_id);
          const nB = getNode(e.node_b_id);
          if (!nA || !nB) return null;
          return (
            <line
              key={i}
              x1={nA.x * 100} y1={nA.y * 100}
              x2={nB.x * 100} y2={nB.y * 100}
              stroke="#3b82f6"
              strokeWidth="4"
              opacity={0.4}
            />
          );
        })}
        {nodes.map((n) => (
          <circle
            key={n.id}
            cx={n.x * 100}
            cy={n.y * 100}
            r={n.type === 'waypoint' ? 10 : 20}
            fill={n.type === 'waypoint' ? '#52525b' : n.type === 'shelf' ? '#06b6d4' : '#ef4444'}
          />
        ))}
      </svg>
    </div>
  );
};

// --- STAT CARD COMPONENT ---
const StatCard: React.FC<{
  title: string,
  value: string | number,
  icon: React.ReactNode,
  trend?: string,
  color?: 'blue' | 'emerald' | 'amber' | 'purple'
}> = ({ title, value, icon, trend, color = 'blue' }) => {

  const colorClasses = {
    blue: "text-blue-500",
    emerald: "text-emerald-500",
    amber: "text-amber-500",
    purple: "text-purple-500"
  };

  const selectedColor = colorClasses[color] || colorClasses.blue;

  return (
    <div className="bg-gray-50 dark:bg-[#1e1e20] p-6 rounded-2xl border border-gray-200 dark:border-white/5 hover:border-blue-500/30 transition-all group relative overflow-hidden">

      <div className={`absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity ${selectedColor}`}>
        {React.cloneElement(icon as React.ReactElement<{ size: number }>, { size: 64 })}
      </div>
      <div className="flex flex-col gap-1 relative z-10">
        <div className="flex items-center gap-2 text-gray-400 text-sm font-medium">
          {React.cloneElement(icon as React.ReactElement<{ size: number }>, { size: 16 })}
          {title}
        </div>
        <div className="text-3xl font-bold text-white tracking-tight">{value}</div>
        {trend && (
          <div className="text-xs text-emerald-400 flex items-center gap-1 mt-1">
            <Activity size={10} /> {trend}
          </div>
        )}
      </div>
    </div>
  );
};

// --- MAIN DASHBOARD COMPONENT ---

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [warehouses, setWarehouses] = useState<DBGraph[]>([]);
  const [robots, setRobots] = useState<DBRobot[]>([]);
  const [activeRequestsCount, setActiveRequestsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");



  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch Graphs
        const { data: gData } = await supabase.from('wh_graphs').select('*').order('id', { ascending: true });
        if (gData) setWarehouses(gData);

        // Fetch Robots (table may not exist in local schema)
        try {
          const { data: rData } = await supabase.from('wh_robots').select('*');
          if (rData) setRobots(rData as DBRobot[]);
        } catch {
          console.warn('[Dashboard] wh_robots table not available');
        }

        // Fetch Requests Stats (table may not exist in local schema)
        try {
          const { count } = await supabase
            .from('wh_requests')
            .select('*', { count: 'exact', head: true })
            .neq('status', 'completed')
            .neq('status', 'cancelled');
          if (count !== null) setActiveRequestsCount(count);
        } catch {
          console.warn('[Dashboard] wh_requests table not available');
        }

      } catch (err) {
        console.error('Error fetching dashboard data:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const handleCreateNew = async () => {
    const name = prompt("Enter new warehouse name:", `Warehouse ${warehouses.length + 1}`);
    if (!name) return;

    try {
      // Use RPC function (direct table insert is blocked by SECURITY DEFINER)
      const { data: newGraphId, error } = await supabase.rpc('wh_create_graph', {
        p_name: name,
      });

      if (error) throw error;
      navigate(`/warehouse/${newGraphId}`);
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      alert(`Failed to create warehouse: ${msg}`);
    }
  };

  const filteredWarehouses = warehouses.filter(w =>
    w.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const activeRobots = robots.filter(r => r.status !== 'offline' && r.status !== 'inactive').length;

  return (
    <div className="min-h-screen bg-white dark:bg-[#09090b] text-gray-900 dark:text-white font-sans flex overflow-hidden selection:bg-blue-500/30">


      {/* SIDEBAR */}
      <div className="w-64 bg-gray-50 dark:bg-[#121214] border-r border-gray-200 dark:border-white/5 flex flex-col hidden md:flex">

        <div className="h-16 flex items-center gap-3 px-6 border-b border-gray-200 dark:border-white/5">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-600/20">
            <LayoutGrid size={18} className="text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">Fleet<span className="text-blue-500">Ctrl</span></span>
        </div>

        <div className="flex-1 py-6 px-3 flex flex-col gap-1">
          <div className="px-3 mb-2 text-xs font-bold text-gray-500 uppercase tracking-wider">Main</div>
          <button className="flex items-center gap-3 px-3 py-2 bg-blue-600/10 text-blue-400 rounded-lg text-sm font-medium border border-blue-600/20">
            <LayoutGrid size={18} /> Dashboard
          </button>
          <button className="flex items-center gap-3 px-3 py-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg text-sm font-medium transition-all">
            <Truck size={18} /> Fleet Status
          </button>
          <button className="flex items-center gap-3 px-3 py-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg text-sm font-medium transition-all">
            <Boxes size={18} /> Inventory
          </button>

          <div className="mt-8 px-3 mb-2 text-xs font-bold text-gray-500 uppercase tracking-wider">System</div>
          <button className="flex items-center gap-3 px-3 py-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg text-sm font-medium transition-all">
            <Activity size={18} /> Analytics
          </button>
          <button className="flex items-center gap-3 px-3 py-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg text-sm font-medium transition-all">
            <Settings size={18} /> Settings
          </button>
        </div>

        <div className="p-4 border-t border-white/5">
          <button className="flex items-center gap-3 px-3 py-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 w-full rounded-lg text-sm font-medium transition-all">
            <LogOut size={18} /> Logout
          </button>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">

        {/* TOPBAR */}
        <div className="h-16 bg-white/80 dark:bg-[#121214]/50 backdrop-blur-md border-b border-gray-200 dark:border-white/5 flex items-center justify-between px-8 sticky top-0 z-20">

          <div className="flex items-center text-sm breadcrumbs text-gray-500">
            <span className="text-gray-300 font-medium">Dashboard</span>
            <ChevronRight size={14} className="mx-2" />
            <span>Overview</span>
          </div>

          <div className="flex items-center gap-6">
            <div className="relative group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-blue-500 transition-colors" size={16} />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search warehouses..."
                className="bg-gray-100 dark:bg-[#1e1e20] border border-gray-200 dark:border-white/5 focus:border-blue-500/50 rounded-full py-2 pl-10 pr-4 text-xs outline-none transition-all w-64 text-gray-900 dark:text-gray-300 placeholder:text-gray-400 dark:placeholder:text-gray-600 focus:w-80"
              />

            </div>
            <ThemeToggle />
            <button className="relative text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-white transition-colors">
              <Bell size={20} />
              <span className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full border border-white dark:border-[#121214]"></span>
            </button>
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-500 to-cyan-400 border border-gray-200 dark:border-white/20 ring-2 ring-gray-100 dark:ring-white/5"></div>

          </div>
        </div>

        {/* SCROLLABLE BODY */}
        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-[1600px] mx-auto space-y-8">

            {/* STATS ROW */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <StatCard
                title="Total Warehouses"
                value={warehouses.length}
                icon={<HardDrive />}
                trend="Active"
              />
              <StatCard
                title="Active Robots"
                value={activeRobots}
                icon={<Truck />}
                color="emerald"
                trend={`${robots.length} Total Fleet`}
              />
              <StatCard
                title="Pending Orders"
                value={activeRequestsCount}
                icon={<Boxes />}
                color="amber"
                trend="Requires Attention"
              />
              <StatCard
                title="System Status"
                value="Online"
                icon={<Activity />}
                color="purple"
                trend="99.9% Uptime"
              />
            </div>

            {/* MAIN SECTION */}
            <div className="flex flex-col gap-6">
              <div className="flex justify-between items-end">
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">Recent Designs</h2>
                  <p className="text-gray-500 text-sm">Manage your warehouse layouts and robot fleets</p>
                </div>

                <button
                  onClick={handleCreateNew}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg shadow-blue-900/20 hover:scale-105 active:scale-95"
                >
                  <Plus size={18} /> New Warehouse
                </button>
              </div>

              {/* GRID */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">

                {/* Create New Card */}
                <div onClick={handleCreateNew} className="group cursor-pointer flex flex-col h-full">
                  <div className="flex-1 bg-[#1e1e20]/50 border-2 border-dashed border-white/10 rounded-2xl flex flex-col items-center justify-center gap-3 min-h-[220px] transition-all group-hover:bg-[#1e1e20] group-hover:border-blue-500/30 group-hover:shadow-lg">
                    <div className="w-12 h-12 rounded-full bg-[#27272a] group-hover:bg-blue-500/20 group-hover:text-blue-500 flex items-center justify-center transition-all text-gray-500">
                      <Plus size={24} />
                    </div>
                    <span className="text-sm font-medium text-gray-500 group-hover:text-blue-400">Start Blank Project</span>
                  </div>
                </div>

                {/* Warehouse Cards */}
                {loading ? (
                  [1, 2, 3].map(i => (
                    <div key={i} className="animate-pulse">
                      <div className="bg-[#1e1e20] rounded-2xl h-[220px] w-full mb-3"></div>
                    </div>
                  ))
                ) : (
                  filteredWarehouses.map((wh) => (
                    <div
                      key={wh.id}
                      onClick={() => navigate(`/warehouse/${wh.id}`)}
                      className="group cursor-pointer flex flex-col gap-3"
                    >
                      {/* Thumbnail */}
                      <div className="relative aspect-[4/3] bg-[#1a1a1c] rounded-2xl overflow-hidden border border-white/5 transition-all group-hover:ring-2 group-hover:ring-blue-500/50 group-hover:shadow-2xl group-hover:shadow-blue-900/10 group-hover:-translate-y-1">
                        <GraphPreview graphId={wh.id} bgUrl={wh.map_url} />

                        {/* Status Badge */}
                        <div className="absolute top-3 right-3 px-2 py-1 bg-black/40 backdrop-blur-md rounded-lg text-[10px] font-mono border border-white/10 text-gray-300">
                          v1.0
                        </div>

                        {/* Hover Overlay */}
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 backdrop-blur-[1px]">
                          <span className="bg-white text-black px-4 py-2 rounded-full text-xs font-bold shadow-lg transform scale-95 group-hover:scale-100 transition-transform">
                            Open Editor
                          </span>
                        </div>
                      </div>

                      {/* Info */}
                      <div className="px-1">
                        <div className="flex justify-between items-start mb-1">
                          <h3 className="font-bold text-gray-200 text-sm truncate group-hover:text-blue-400 transition-colors">
                            {wh.name}
                          </h3>
                          <button className="text-gray-600 hover:text-white transition-colors p-1 hover:bg-white/10 rounded">
                            <MoreVertical size={14} />
                          </button>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-gray-500 font-medium">
                          <span className="flex items-center gap-1">
                            <Clock size={10} /> 2m ago
                          </span>
                          <span className="flex items-center gap-1">
                            <HardDrive size={10} /> {((wh.map_url?.length || 0) / 1024).toFixed(1)} KB
                          </span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;