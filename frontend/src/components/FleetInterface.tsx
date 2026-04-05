import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LayoutGrid, Cpu, Activity, ArrowLeft, Terminal, FlaskConical, ChevronDown, Bell, AlertTriangle, X } from 'lucide-react';
import GraphEditor from './GraphEditor';
import Optimization from './Optimization';
import FleetController from './FleetController';
import FleetControlPanel from './GraphQLTester';
import ThemeToggle from './ThemeToggle';
import { VEHICLE_ROBOT_MAP, setVehicleRobot } from '../utils/fleetGateway';
import { type DBNode } from '../types/database';
import { useFleetGateway } from '../hooks/useFleetGateway';

const FleetInterface: React.FC = () => {
  const { graphId } = useParams<{ graphId: string }>(); // Get ID from URL
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<'graph' | 'opt' | 'fleet' | 'gql'>('graph');
  const [simMode, setSimMode] = useState(false);
  const [robotSelectorOpen, setRobotSelectorOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);

  // Shared state: VRP simulation routes (number[][] — one path per vehicle)
  // Used purely for drawing the visual green paths on the Fleet tab.
  const [simulationRoutes, setSimulationRoutes] = useState<number[][] | null>(null);

  // Shared robot telemetry + mutations — called ONCE here, values passed as props.
  const {
    robots: gqlRobots,
    connected: gqlConnected,
    activeRobotName,
    setActiveRobotName,
    dispatchRequest,
    hardReset,
    alerts,
    dismissAlert,
  } = useFleetGateway(simMode);

  // Global toasts derived from fleet alerts
  const [globalToasts, setGlobalToasts] = useState<{ id: string; msg: string; type: 'error' | 'warn' | 'info' }[]>([]);
  const shownAlertIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    alerts.forEach(alert => {
      if (shownAlertIds.current.has(alert.id)) return;
      shownAlertIds.current.add(alert.id);

      const type: 'error' | 'warn' | 'info' =
        alert.type === 'offline' ? 'error' :
        alert.type === 'battery_low' ? 'warn' : 'error';

      const toast = { id: alert.id, msg: alert.message, type };
      setGlobalToasts(prev => [...prev, toast]);

      setTimeout(() => {
        setGlobalToasts(prev => prev.filter(t => t.id !== toast.id));
      }, 6000);
    });
  }, [alerts]);

  // Keep VEHICLE_ROBOT_MAP[0] in sync with the globally active robot.
  useEffect(() => {
    if (activeRobotName) {
      setVehicleRobot(0, activeRobotName);
    }
  }, [activeRobotName]);

  // Close the robot selector dropdown when clicking outside it.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setRobotSelectorOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Active robot object for status checks.
  const activeRobot = gqlRobots.find(r => r.name === activeRobotName);
  const activeRobotOffline = activeRobot?.connectionStatus === 'OFFLINE';
  const onlineAlternatives = gqlRobots.filter(
    r => r.name !== activeRobotName && r.connectionStatus === 'ONLINE',
  );

  /**
   * Called by Optimization when the user clicks "DISPATCH".
   *
   * @remarks
   * **Visual-only — no robot command is sent here.**
   *
   * This handler's sole responsibility is to update the Fleet tab's route
   * visualisation and switch the active tab so the operator can see the
   * planned paths on the map.
   *
   * **Why `executePathOrder` is NOT called here**
   *
   * The Fleet Gateway's `executePathOrder` mutation persists the route to the
   * database but does **not** publish to the Redis channel that the robot's
   * motion controller subscribes to.  The robot therefore never receives the
   * command even though the mutation returns success.
   *
   * The proven workaround is `sendRequestOrder`, which follows a different
   * server code-path that correctly publishes to Redis.  All actual robot
   * commands are fired by `handleVRPDispatch` inside `Optimization.tsx` via
   * the `onGQLDispatch` prop (`useFleetGateway.dispatchRequest`), one
   * `sendRequestOrder` call per pickup-delivery task in VRP-optimised order.
   *
   * @param expandedRoutes - Full A*-expanded paths for visual rendering only.
   */
  const handleDispatch = useCallback((
    expandedRoutes: number[][],
    _vrpWaypoints: number[][], // Retained for API compatibility; not used here.
    _nodes: DBNode[],          // Retained for API compatibility; not used here.
  ) => {
    setSimulationRoutes(expandedRoutes);
    setActiveTab('fleet');
  }, []);

  // Basic validation
  if (!graphId) return <div>Error: No Warehouse ID provided.</div>;

  const currentGraphId = parseInt(graphId, 10);

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-[#09090b] text-gray-900 dark:text-white transition-colors">

      {/* HEADER */}
      <div className="h-14 bg-white dark:bg-[#121214] border-b border-gray-200 dark:border-white/5 px-4 flex justify-between items-center shadow-sm z-20">

        <div className="flex items-center gap-4">

          {/* Back Button */}
          <button
            onClick={() => navigate('/')}
            className="p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 rounded-full transition-colors"
            title="Back to Dashboard"
          >
            <ArrowLeft size={20} />
          </button>

          <div className="h-6 w-px bg-gray-200 dark:bg-white/10"></div>

          <h1 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">
            Warehouse Editor <span className="text-slate-400 text-xs font-mono ml-2">#{currentGraphId}</span>
          </h1>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex bg-gray-100 dark:bg-white/5 p-1 rounded-lg border border-gray-200 dark:border-white/10">
            <button
              onClick={() => setActiveTab('graph')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeTab === 'graph' ? 'bg-white dark:bg-white/10 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white'}`}
            >
              <LayoutGrid size={14} /> GRAPH
            </button>
            <button
              onClick={() => setActiveTab('opt')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeTab === 'opt' ? 'bg-white dark:bg-white/10 text-purple-600 dark:text-purple-400 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white'}`}
            >
              <Cpu size={14} /> OPTIMIZATION
            </button>
            <button
              onClick={() => setActiveTab('fleet')}
              className={`relative flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeTab === 'fleet' ? 'bg-white dark:bg-white/10 text-green-600 dark:text-green-400 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white'}`}
            >
              <Activity size={14} /> FLEET
              {alerts.length > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-1 shadow-sm">
                  {alerts.length > 9 ? '9+' : alerts.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('gql')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeTab === 'gql' ? 'bg-white dark:bg-white/10 text-orange-500 dark:text-orange-400 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white'}`}
            >
              <Terminal size={14} /> GQL TESTER
            </button>
          </div>

          <div className="h-6 w-px bg-gray-200 dark:bg-white/10 ml-2"></div>

          {/* Robot Selector */}
          <div className="relative" ref={selectorRef}>
            <button
              onClick={() => setRobotSelectorOpen(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                activeRobotOffline
                  ? 'bg-red-500/10 border-red-400/40 text-red-400'
                  : activeRobotName
                    ? 'bg-green-500/10 border-green-400/30 text-green-600 dark:text-green-400'
                    : 'bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400'
              }`}
              title="Select active robot"
            >
              {/* Status dot */}
              <span className={`w-1.5 h-1.5 rounded-full ${
                activeRobotOffline ? 'bg-red-400' :
                activeRobotName ? 'bg-green-500' :
                'bg-gray-400'
              }`} />
              <span className="max-w-[80px] truncate">{activeRobotName || 'No Robot'}</span>
              <ChevronDown size={11} className={`transition-transform ${robotSelectorOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown */}
            {robotSelectorOpen && (
              <div className="absolute right-0 top-full mt-1 min-w-[160px] bg-white dark:bg-[#1a1a1e] border border-gray-200 dark:border-white/10 rounded-lg shadow-lg py-1 z-50">
                {gqlRobots.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-400">No robots available</div>
                ) : (
                  gqlRobots.map(robot => {
                    const isOnline = robot.connectionStatus === 'ONLINE';
                    const isActive = robot.name === activeRobotName;
                    return (
                      <button
                        key={robot.name}
                        onClick={() => {
                          setActiveRobotName(robot.name);
                          setRobotSelectorOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                          isActive
                            ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isOnline ? 'bg-green-500' : 'bg-red-400'}`} />
                        <span className="flex-1 truncate font-mono">{robot.name}</span>
                        <span className={`text-[10px] ${isOnline ? 'text-green-500' : 'text-red-400'}`}>
                          {robot.lastActionStatus}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Simulation Mode toggle */}
          <button
            onClick={() => setSimMode(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${simMode
              ? 'bg-amber-500/15 border-amber-400/40 text-amber-500 dark:text-amber-400'
              : 'bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white'}`}
            title={simMode ? 'Simulation Mode: ON — click to disable' : 'Simulation Mode: OFF — click to enable'}
          >
            <FlaskConical size={13} />
            SIM
          </button>

          {/* GQL Gateway connection indicator */}
          <div
            className={`w-2 h-2 rounded-full transition-colors ${gqlConnected
              ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]'
              : 'bg-gray-400'}`}
            title={gqlConnected ? 'Robot gateway: connected' : 'Robot gateway: offline'}
          />

          <ThemeToggle />
        </div>

      </div>

      {/* Offline hint banner — shown when the active robot is OFFLINE and alternatives exist */}
      {activeRobotOffline && onlineAlternatives.length > 0 && (
        <div className="bg-amber-500/10 border-b border-amber-400/20 px-4 py-1.5 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 z-10">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
          <span>
            <strong>{activeRobotName}</strong> is OFFLINE.
            Switch to:{' '}
            {onlineAlternatives.map((r, i) => (
              <React.Fragment key={r.name}>
                {i > 0 && ', '}
                <button
                  onClick={() => setActiveRobotName(r.name)}
                  className="underline underline-offset-2 hover:text-amber-500 font-mono"
                >
                  {r.name}
                </button>
              </React.Fragment>
            ))}
          </span>
        </div>
      )}

      {/* GLOBAL TOAST PANEL - Fleet Alerts */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {globalToasts.map(toast => (
          <div
            key={toast.id}
            className={`flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl shadow-xl border backdrop-blur-sm text-xs font-bold pointer-events-auto animate-in slide-in-from-right-4 fade-in min-w-[260px] max-w-xs ${
              toast.type === 'error'
                ? 'bg-red-500/90 border-red-400/50 text-white'
                : toast.type === 'warn'
                  ? 'bg-amber-500/90 border-amber-400/50 text-white'
                  : 'bg-slate-800/90 border-white/10 text-white'
            }`}
          >
            {toast.type === 'error' ? (
              <Bell size={13} className="shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            )}
            <span className="flex-1 leading-snug">{toast.msg}</span>
            <button
              onClick={() => {
                setGlobalToasts(prev => prev.filter(t => t.id !== toast.id));
                dismissAlert(toast.id);
              }}
              className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* CONTENT AREA - PASS ID DOWN */}
      <div className="flex-1 overflow-hidden relative">
        {activeTab === 'graph' && <GraphEditor graphId={currentGraphId} />}
        {activeTab === 'opt' && (
          <Optimization
            graphId={currentGraphId}
            onDispatch={handleDispatch}
            gqlRobots={gqlRobots}
            simMode={simMode}
            onGQLDispatch={dispatchRequest}
            activeRobotName={activeRobotName}
          />
        )}
        {activeTab === 'fleet' && (
          <FleetController
            graphId={currentGraphId}
            simulationRoutes={simulationRoutes}
            gqlRobots={gqlRobots}
            simMode={simMode}
            onHardReset={hardReset}
            activeRobotName={activeRobotName}
          />
        )}
        {activeTab === 'gql' && (
          <FleetControlPanel
            activeRobotName={activeRobotName}
            onRobotChange={setActiveRobotName}
          />
        )}
      </div>
    </div>
  );
};

export default FleetInterface;
