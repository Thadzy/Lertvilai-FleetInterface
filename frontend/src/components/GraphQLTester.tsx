/**
 * FleetControlPanel — Industrial Robot Fleet Control UI
 * ======================================================
 * Button-based control panel for the Fleet Gateway GraphQL API.
 * Proxied via Vite dev-server: /api/robot-gw → http://10.61.6.87:8080
 *
 * Layout
 * ──────
 *   LEFT   (224 px) — Robot selector + live status dashboard
 *   CENTER (flex-1) — Action cards: Navigation / Task Builder / Recovery
 *   RIGHT  (320 px) — Live job queue + collapsible System Log
 *
 * Simulation Mode
 * ───────────────
 * When enabled, all mutations are intercepted client-side. A 500 ms artificial
 * delay fires, the local robot state is updated optimistically, and a structured
 * [SIMULATION] entry is written to the System Log. No network traffic is sent,
 * making the panel safe to demo without affecting physical hardware.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  MapPin,
  Package,
  AlertTriangle,
  RefreshCw,
  Play,
  Wifi,
  WifiOff,
  CheckCircle2,
  XCircle,
  Ban,
  Loader2,
  ChevronRight,
  Layers,
  ToggleLeft,
  ToggleRight,
  Radio,
  Inbox,
  Terminal,
  ChevronDown,
  ChevronUp,
  Search,
  FlaskConical,
  X,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = '/api/robot-gw/graphql';
/** Live polling interval in milliseconds. */
const POLL_MS = 2000;
/** Simulated network delay in milliseconds when Simulation Mode is active. */
const SIM_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GQLJob {
  uuid: string;
  /** QUEUING | IN_PROGRESS | COMPLETED | FAILED | CANCELLED */
  status: string;
  /** TRAVEL | PICKUP | DELIVERY */
  operation: string;
  targetNode?: { alias: string } | null;
}

interface GQLRobot {
  name: string;
  /** ONLINE | OFFLINE */
  connectionStatus: string;
  /** IDLE | OPERATING | ERROR */
  lastActionStatus: string;
  mobileBaseState?: { pose: { x: number; y: number; a: number } } | null;
  currentJob?: GQLJob | null;
  jobQueue?: GQLJob[] | null;
}

/** Standard return shape for most Fleet Gateway mutations. */
interface MutResult {
  success: boolean;
  message: string;
}

/** Extended return shape for `sendRequestOrder` — includes the created request stub. */
interface RequestOrderResult extends MutResult {
  request?: { uuid: string; status: string } | null;
}

/**
 * Return shape for `cancelJobs` — returns an array of updated job stubs
 * rather than a single success/message pair.
 */
interface CancelJobsResult {
  uuid: string;
  status: string;
}

type ToastType = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

/**
 * Identifies which async action is currently in-flight.
 * Per-key granularity prevents one loading state from blocking unrelated buttons.
 * `cancelJob-<uuid>` keys are generated dynamically for per-job cancel buttons.
 */
type LoadingKey =
  | 'travel'
  | 'dispatch'
  | 'clearError'
  | 'cancelAll'
  | 'freeCell'
  | 'autorun'
  | 'introspect';

type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'sim';

interface LogEntry {
  id: number;
  /** Wall-clock time string, e.g. "14:32:07" */
  ts: string;
  level: LogLevel;
  /** Short identifier, e.g. "mutation/sendTravel" */
  label: string;
  /** Pre-serialised JSON or plain message text */
  body: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL transport layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a GraphQL request and returns the typed `data` payload.
 * Throws on HTTP errors **and** on GraphQL-level errors (first error message).
 */
async function gql<T = unknown>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from gateway`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data as T;
}

/**
 * Like `gql()` but returns the raw `{data, errors}` envelope without throwing
 * on GraphQL errors. Used by the polling loop and introspection so that server
 * errors surface in the System Log rather than propagating as exceptions.
 */
async function gqlRaw(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: unknown; errors?: { message: string }[] }> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from gateway`);
  return res.json() as Promise<{ data?: unknown; errors?: { message: string }[] }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a resolved MutResult after a short artificial delay.
 * Used by every mutation handler when Simulation Mode is active.
 */
function simulateMut(mutationName: string, payload: unknown): Promise<MutResult> {
  return new Promise(resolve =>
    setTimeout(() => {
      console.info(`[SIM] ${mutationName}`, payload);
      resolve({ success: true, message: `[SIMULATION] ${mutationName} acknowledged` });
    }, SIM_DELAY_MS),
  );
}

/**
 * Returns simulated cancelJobs results after a short artificial delay.
 * Marks each provided uuid as CANCELLED.
 */
function simulateCancelJobs(uuids: string[]): Promise<CancelJobsResult[]> {
  return new Promise(resolve =>
    setTimeout(
      () => resolve(uuids.map(uuid => ({ uuid, status: 'CANCELLED' }))),
      SIM_DELAY_MS,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation helpers — each wraps a single GraphQL mutation
// ─────────────────────────────────────────────────────────────────────────────

/** Sends a point-to-point travel order to the named robot. */
async function sendTravel(
  endpoint: string,
  robotName: string,
  targetAlias: string,
): Promise<MutResult> {
  const data = await gql<{ sendTravelOrder: MutResult }>(
    endpoint,
    `mutation SendTravel($robotName: String!, $targetAlias: String!) {
       sendTravelOrder(travelOrder: { robotName: $robotName, targetNodeAlias: $targetAlias }) {
         success message
       }
     }`,
    { robotName, targetAlias },
  );
  return data.sendTravelOrder;
}

/**
 * Dispatches a pick-and-deliver request order to the named robot.
 *
 * Uses the nested `requestOrder → requestAlias` input structure required by the
 * Fleet Gateway schema. Flat arguments (e.g. `pickupAlias: $pickup`) were
 * previously rejected by the backend with "Unknown argument" errors.
 */
async function sendRequest(
  endpoint: string,
  robotName: string,
  pickupAlias: string,
  deliveryAlias: string,
): Promise<RequestOrderResult> {
  const data = await gql<{ sendRequestOrder: RequestOrderResult }>(
    endpoint,
    `mutation SendRequestOrder($robotName: String!, $pickupAlias: String!, $deliveryAlias: String!) {
       sendRequestOrder(requestOrder: {
         robotName: $robotName
         requestAlias: {
           pickupNodeAlias: $pickupAlias
           deliveryNodeAlias: $deliveryAlias
         }
       }) {
         success
         message
         request { uuid status }
       }
     }`,
    { robotName, pickupAlias, deliveryAlias },
  );
  return data.sendRequestOrder;
}

/**
 * Clears the error state on the named robot.
 * The schema returns either a plain Boolean or {success, message} — both are normalised.
 */
async function clearRobotError(endpoint: string, robotName: string): Promise<MutResult> {
  const data = await gql<{ clearRobotError: boolean | MutResult }>(
    endpoint,
    `mutation ClearError($robotName: String!) { clearRobotError(robotName: $robotName) }`,
    { robotName },
  );
  const raw = data.clearRobotError;
  if (typeof raw === 'boolean') return { success: raw, message: raw ? 'Error cleared' : 'Clear failed' };
  return raw as MutResult;
}

/** Cancels ALL queued jobs on the named robot (bulk cancel, no uuid filter). */
async function cancelAllJobs(endpoint: string, robotName: string): Promise<MutResult> {
  const data = await gql<{ cancelJobs: MutResult }>(
    endpoint,
    `mutation CancelAll($robotName: String!) {
       cancelJobs(robotName: $robotName) { success message }
     }`,
    { robotName },
  );
  return data.cancelJobs;
}

/**
 * Cancels specific jobs by UUID array.
 *
 * Schema: `mutation CancelSpecificJobs($uuids: [UUID!]!) { cancelJobs(uuids: $uuids) { uuid status } }`
 *
 * The UI always passes a single-element array so the user cancels one job at a time,
 * but the function accepts multiple UUIDs for future batch use.
 */
async function cancelSpecificJobs(
  endpoint: string,
  uuids: string[],
): Promise<CancelJobsResult[]> {
  const data = await gql<{ cancelJobs: CancelJobsResult[] }>(
    endpoint,
    `mutation CancelSpecificJobs($uuids: [UUID!]!) {
       cancelJobs(uuids: $uuids) { uuid status }
     }`,
    { uuids },
  );
  return data.cancelJobs;
}

/** Frees (clears the reservation on) a single robot cell slot by index. */
async function freeRobotCell(
  endpoint: string,
  robotName: string,
  cellIndex: number,
): Promise<MutResult> {
  const data = await gql<{ freeRobotCell: MutResult }>(
    endpoint,
    `mutation FreeCell($robotName: String!, $cellIndex: Int!) {
       freeRobotCell(robotName: $robotName, cellIndex: $cellIndex) { success message }
     }`,
    { robotName, cellIndex },
  );
  return data.freeRobotCell;
}

/** Enables or disables automatic job processing on the named robot. */
async function setAutorun(
  endpoint: string,
  robotName: string,
  enabled: boolean,
): Promise<MutResult> {
  const data = await gql<{ setAutorun: MutResult }>(
    endpoint,
    `mutation SetAutorun($robotName: String!, $enabled: Boolean!) {
       setAutorun(robotName: $robotName, enabled: $enabled) { success message }
     }`,
    { robotName, enabled },
  );
  return data.setAutorun;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

const ROBOTS_QUERY = `
  query GetRobots {
    robots {
      name
      connectionStatus
      lastActionStatus
      mobileBaseState { pose { x y a } }
      currentJob { uuid status operation targetNode { alias } }
      jobQueue   { uuid status operation targetNode { alias } }
    }
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Presentational micro-components
// ─────────────────────────────────────────────────────────────────────────────

function ConnectionBadge({ status }: { status: string }) {
  const online = status === 'ONLINE';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${online ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-gray-500/15 text-gray-400 border-gray-500/30'}`}>
      {online ? <Wifi size={9} /> : <WifiOff size={9} />}
      {status}
    </span>
  );
}

function ActionBadge({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    IDLE:      'bg-green-500/15 text-green-400 border-green-500/30',
    OPERATING: 'bg-blue-500/15  text-blue-400  border-blue-500/30',
    ERROR:     'bg-red-500/15   text-red-400   border-red-500/30',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${cfg[status] ?? 'bg-gray-500/15 text-gray-400 border-gray-500/30'}`}>
      {status}
    </span>
  );
}

function JobStatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    IN_PROGRESS: 'bg-blue-400 animate-pulse',
    QUEUING:     'bg-amber-400',
    COMPLETED:   'bg-green-400',
    FAILED:      'bg-red-400',
    CANCELLED:   'bg-gray-500',
  };
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 mt-0.5 ${map[status] ?? 'bg-gray-500'}`} />;
}

function OperationIcon({ op }: { op: string }) {
  if (op === 'PICKUP')   return <Package size={12} className="text-amber-400" />;
  if (op === 'DELIVERY') return <Package size={12} className="text-blue-400" />;
  return <MapPin size={12} className="text-gray-400" />;
}

function JobStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    IN_PROGRESS: 'bg-blue-500/20 text-blue-400',
    QUEUING:     'bg-amber-500/20 text-amber-400',
    COMPLETED:   'bg-green-500/20 text-green-400',
    FAILED:      'bg-red-500/20 text-red-400',
    CANCELLED:   'bg-gray-500/20 text-gray-500',
  };
  return (
    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${map[status] ?? 'bg-gray-500/20 text-gray-500'}`}>
      {status}
    </span>
  );
}

interface SectionCardProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  accent?: string;
}
function SectionCard({ title, icon, children, accent = 'border-white/5' }: SectionCardProps) {
  return (
    <div className={`rounded-xl border ${accent} bg-[#121214] overflow-hidden`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <span className="text-gray-400">{icon}</span>
        <span className="text-xs font-bold uppercase tracking-widest text-gray-300">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">{children}</p>;
}

const inputCls  = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 transition';
const selectCls = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500 transition appearance-none cursor-pointer';

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface FleetControlPanelProps {
  activeRobotName?: string;
  onRobotChange?: (name: string) => void;
}

const FleetControlPanel: React.FC<FleetControlPanelProps> = ({ activeRobotName, onRobotChange }) => {

  // ── Core state ─────────────────────────────────────────────────────────────
  const [endpoint]                      = useState(DEFAULT_ENDPOINT);
  const [robots,       setRobots]       = useState<GQLRobot[]>([]);
  const [selectedName, setSelectedName] = useState<string>('');
  const [pollError,    setPollError]    = useState<string | null>(null);

  // Sync selected robot when activeRobotName prop changes and the robot is in the list.
  useEffect(() => {
    if (activeRobotName && (robots.length === 0 || robots.some(r => r.name === activeRobotName))) {
      setSelectedName(activeRobotName);
    }
  }, [activeRobotName, robots]);

  // ── Simulation Mode ────────────────────────────────────────────────────────
  /**
   * When true, all mutation calls are short-circuited to `simulateMut()`.
   * The polling loop continues to run against the real gateway so live data
   * is still visible while the mode is on (useful for partial demos).
   */
  const [simMode, setSimMode] = useState(false);

  // ── Toast state ────────────────────────────────────────────────────────────
  const [toasts,      setToasts]      = useState<Toast[]>([]);
  const toastCounter                  = useRef(0);

  // ── Form state ─────────────────────────────────────────────────────────────
  const [waypoint,      setWaypoint]      = useState('');
  const [pickupAlias,   setPickupAlias]   = useState('');
  const [deliveryAlias, setDeliveryAlias] = useState('');
  const [cellIndex,     setCellIndex]     = useState(0);
  const [autorunOn,     setAutorunOn]     = useState(false);

  // ── Per-action loading state ───────────────────────────────────────────────
  /**
   * Standard actions use a fixed LoadingKey.
   * Per-job cancel buttons use a dynamic `cancelJob-<uuid>` string key so
   * each row's spinner is independent.
   */
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const setLoad  = useCallback((key: string, val: boolean) =>
    setLoading(prev => ({ ...prev, [key]: val })), []);

  // ── System Log state ───────────────────────────────────────────────────────
  const [logs,    setLogs]    = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const logCounter            = useRef(0);
  const logEndRef             = useRef<HTMLDivElement>(null);

  /** Appends a structured entry to the System Log, capping the buffer at 200 lines. */
  const addLog = useCallback((level: LogLevel, label: string, body: unknown) => {
    const id   = ++logCounter.current;
    const ts   = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    setLogs(prev => [...prev.slice(-199), { id, ts, level, label, body: text }]);
  }, []);

  // Auto-scroll log to latest entry whenever it updates and the panel is open.
  useEffect(() => {
    if (logOpen) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, logOpen]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const selectedRobot = robots.find(r => r.name === selectedName) ?? null;
  const isError       = selectedRobot?.lastActionStatus === 'ERROR';

  // ── Toast helper ───────────────────────────────────────────────────────────
  const addToast = useCallback((type: ToastType, message: string) => {
    const id = ++toastCounter.current;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  // ── Polling ────────────────────────────────────────────────────────────────
  /**
   * Uses `gqlRaw` so that GraphQL errors are written to the System Log rather
   * than silently swallowed or thrown as unhandled exceptions.
   */
  const pollRobots = useCallback(async () => {
    try {
      const raw = await gqlRaw(endpoint, ROBOTS_QUERY);
      if (raw.errors?.length) {
        raw.errors.forEach(e => addLog('error', 'poll/GQL', e.message));
        setPollError(raw.errors[0].message);
        return;
      }
      const data = raw.data as { robots: GQLRobot[] } | undefined;
      addLog('ok', 'poll/robots', raw);
      setRobots(data?.robots ?? []);
      setPollError(null);
      setSelectedName(prev => prev || data?.robots?.[0]?.name || '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cannot reach gateway';
      addLog('error', 'poll/network', msg);
      setPollError(msg);
    }
  }, [endpoint, addLog]);

  useEffect(() => {
    void pollRobots();
    const id = setInterval(() => void pollRobots(), POLL_MS);
    return () => clearInterval(id);
  }, [pollRobots]);

  // ── Shared mutation executor ───────────────────────────────────────────────
  /**
   * Wraps any `() => Promise<MutResult>` with:
   *   1. Loading-key activation / deactivation
   *   2. Success / error toast
   *   3. Immediate re-poll to refresh robot state
   *   4. System Log entry for both outcomes
   */
  const exec = useCallback(async (
    key: LoadingKey,
    label: string,
    fn: () => Promise<MutResult>,
  ) => {
    setLoad(key, true);
    try {
      const result = await fn();
      const lvl: LogLevel = result.success ? (simMode ? 'sim' : 'ok') : 'warn';
      addLog(lvl, `mutation/${label}`, result);
      addToast(result.success ? 'success' : 'error', result.message || (result.success ? 'Done' : 'Command rejected'));
      await pollRobots();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      addLog('error', `mutation/${label}`, msg);
      addToast('error', msg);
    } finally {
      setLoad(key, false);
    }
  }, [addLog, addToast, pollRobots, setLoad, simMode]);

  // ── Action handlers ────────────────────────────────────────────────────────

  /** Sends a travel order; in sim mode returns a synthetic success response. */
  const handleTravel = () => {
    if (!selectedName || !waypoint.trim()) return;
    const payload = { robotName: selectedName, targetAlias: waypoint.trim() };
    if (simMode) {
      addLog('sim', 'mutation/sendTravel',
        `[SIMULATION] Command 'sendTravelOrder' sent successfully with payload: ${JSON.stringify(payload)}`);
      void exec('travel', 'sendTravel', () => simulateMut('sendTravelOrder', payload));
    } else {
      void exec('travel', 'sendTravel', () => sendTravel(endpoint, selectedName, waypoint.trim()));
    }
  };

  /**
   * Dispatches a pick-and-deliver task using the nested `requestOrder → requestAlias`
   * mutation structure.
   *
   * On success:
   *   - Logs the returned Request UUID to the System Log.
   *   - Clears both input fields to signal completion and prevent accidental re-dispatch.
   *
   * In Simulation Mode:
   *   - Intercepts the call, returns a synthetic UUID, and logs the full payload.
   *   - No network request is made.
   */
  const handleDispatch = () => {
    if (!selectedName || !pickupAlias.trim() || !deliveryAlias.trim()) return;
    const pickup   = pickupAlias.trim();
    const delivery = deliveryAlias.trim();
    const payload  = { robotName: selectedName, pickupAlias: pickup, deliveryAlias: delivery };

    if (simMode) {
      const simUuid = `sim-${Date.now()}`;
      addLog('sim', 'mutation/sendRequestOrder',
        `[SIMULATION] Command 'sendRequestOrder' triggered for ${selectedName} from ${pickup} to ${delivery}\n` +
        `Simulated Request UUID: ${simUuid}`);
      void exec('dispatch', 'sendRequestOrder', () => simulateMut('sendRequestOrder', payload));
      setPickupAlias('');
      setDeliveryAlias('');
    } else {
      setLoad('dispatch', true);
      sendRequest(endpoint, selectedName, pickup, delivery)
        .then(result => {
          const lvl: LogLevel = result.success ? 'ok' : 'warn';
          if (result.success && result.request?.uuid) {
            addLog(lvl, 'mutation/sendRequestOrder',
              `Request created — UUID: ${result.request.uuid}  status: ${result.request.status}`);
            addToast('success', `Task dispatched · UUID: ${result.request.uuid.slice(0, 8)}…`);
            // Clear fields on confirmed success so the form is ready for the next task.
            setPickupAlias('');
            setDeliveryAlias('');
          } else {
            addLog(lvl, 'mutation/sendRequestOrder', result);
            addToast(result.success ? 'success' : 'error',
              result.message || (result.success ? 'Task dispatched' : 'Dispatch rejected'));
          }
          void pollRobots();
        })
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          addLog('error', 'mutation/sendRequestOrder', msg);
          addToast('error', msg);
        })
        .finally(() => setLoad('dispatch', false));
    }
  };

  /** Clears robot error; only enabled when lastActionStatus === 'ERROR'. */
  const handleClearError = () => {
    if (!selectedName) return;
    const payload = { robotName: selectedName };
    if (simMode) {
      addLog('sim', 'mutation/clearError',
        `[SIMULATION] Command 'clearRobotError' sent successfully with payload: ${JSON.stringify(payload)}`);
      // Optimistically flip the local robot status to IDLE for UI feedback.
      setRobots(prev => prev.map(r =>
        r.name === selectedName ? { ...r, lastActionStatus: 'IDLE' } : r));
      void exec('clearError', 'clearRobotError', () => simulateMut('clearRobotError', payload));
    } else {
      void exec('clearError', 'clearRobotError', () => clearRobotError(endpoint, selectedName));
    }
  };

  /** Cancels all queued jobs on the selected robot. */
  const handleCancelAll = () => {
    if (!selectedName) return;
    const payload = { robotName: selectedName };
    if (simMode) {
      addLog('sim', 'mutation/cancelJobs',
        `[SIMULATION] Command 'cancelJobs' (all) sent successfully with payload: ${JSON.stringify(payload)}`);
      // Optimistically clear the local job queue.
      setRobots(prev => prev.map(r =>
        r.name === selectedName ? { ...r, currentJob: null, jobQueue: [] } : r));
      void exec('cancelAll', 'cancelJobs(all)', () => simulateMut('cancelJobs', payload));
    } else {
      void exec('cancelAll', 'cancelJobs(all)', () => cancelAllJobs(endpoint, selectedName));
    }
  };

  /**
   * Cancels a specific job by UUID.
   * Uses a dynamic loading key `cancelJob-<uuid>` so each row has its own spinner.
   * In sim mode: optimistically marks the job as CANCELLED in local state.
   */
  const handleCancelJob = useCallback((uuid: string) => {
    const key = `cancelJob-${uuid}`;
    const payload = { uuids: [uuid] };
    setLoad(key, true);

    const run = async () => {
      try {
        let cancelled: CancelJobsResult[];

        if (simMode) {
          addLog('sim', 'mutation/cancelJobs',
            `[SIMULATION] Command 'cancelJobs' sent successfully with payload: ${JSON.stringify(payload)}`);
          cancelled = await simulateCancelJobs([uuid]);
          // Optimistically update local robot state so the row reflects CANCELLED immediately.
          setRobots(prev => prev.map(r => {
            if (r.name !== selectedName) return r;
            const patch = (j: GQLJob): GQLJob =>
              j.uuid === uuid ? { ...j, status: 'CANCELLED' } : j;
            return {
              ...r,
              currentJob: r.currentJob ? patch(r.currentJob) : r.currentJob,
              jobQueue:   r.jobQueue?.map(patch) ?? [],
            };
          }));
        } else {
          cancelled = await cancelSpecificJobs(endpoint, [uuid]);
        }

        addLog(simMode ? 'sim' : 'ok', 'mutation/cancelJobs', cancelled);
        addToast('success', `Job ${uuid.slice(0, 8)}… cancelled`);
        if (!simMode) await pollRobots();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        addLog('error', 'mutation/cancelJobs', msg);
        addToast('error', msg);
      } finally {
        setLoad(key, false);
      }
    };

    void run();
  }, [simMode, selectedName, endpoint, addLog, addToast, pollRobots, setLoad]);

  /** Frees a robot cell slot by index. */
  const handleFreeCell = () => {
    if (!selectedName) return;
    const payload = { robotName: selectedName, cellIndex };
    if (simMode) {
      addLog('sim', 'mutation/freeRobotCell',
        `[SIMULATION] Command 'freeRobotCell' sent successfully with payload: ${JSON.stringify(payload)}`);
      void exec('freeCell', 'freeRobotCell', () => simulateMut('freeRobotCell', payload));
    } else {
      void exec('freeCell', 'freeRobotCell', () => freeRobotCell(endpoint, selectedName, cellIndex));
    }
  };

  /** Toggles autorun on the selected robot. */
  const handleAutorun = (enabled: boolean) => {
    if (!selectedName) return;
    setAutorunOn(enabled);
    const payload = { robotName: selectedName, enabled };
    if (simMode) {
      addLog('sim', 'mutation/setAutorun',
        `[SIMULATION] Command 'setAutorun' sent successfully with payload: ${JSON.stringify(payload)}`);
      void exec('autorun', 'setAutorun', () => simulateMut('setAutorun', payload));
    } else {
      void exec('autorun', 'setAutorun', () => setAutorun(endpoint, selectedName, enabled));
    }
  };

  /**
   * Runs a GraphQL introspection query for the given type name and dumps
   * the full field list into the System Log.
   */
  const handleIntrospect = async (typeName: string) => {
    setLoad('introspect', true);
    addLog('info', `introspect/${typeName}`, `Querying __type(name: "${typeName}")…`);
    try {
      const raw = await gqlRaw(endpoint, `
        query IntrospectType($name: String!) {
          __type(name: $name) {
            name kind
            fields { name type { name kind ofType { name kind } } }
            enumValues { name }
          }
        }`, { name: typeName });
      addLog(raw.errors?.length ? 'error' : 'ok', `introspect/${typeName}`, raw);
    } catch (err) {
      addLog('error', `introspect/${typeName}`, err instanceof Error ? err.message : String(err));
    } finally {
      setLoad('introspect', false);
    }
  };

  // ── Inline spinner ─────────────────────────────────────────────────────────
  const Spinner = () => <Loader2 size={13} className="animate-spin" />;

  // ───────────────────────────────────────────────────────────────────────────
  // RENDER
  // ───────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full bg-[#09090b] text-white overflow-hidden">

      {/* ── Toast rack ────────────────────────────────────────────────────── */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-xl text-sm font-medium border pointer-events-auto transition-all ${
              t.type === 'success' ? 'bg-green-950 border-green-500/40 text-green-300' :
              t.type === 'error'   ? 'bg-red-950  border-red-500/40   text-red-300'   :
                                     'bg-blue-950 border-blue-500/40  text-blue-300'
            }`}
          >
            {t.type === 'success' ? <CheckCircle2 size={14} /> :
             t.type === 'error'   ? <XCircle      size={14} /> :
                                    <Radio         size={14} />}
            {t.message}
          </div>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          LEFT SIDEBAR — Robot selector + live status
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="w-56 flex-shrink-0 flex flex-col border-r border-white/5 bg-[#0c0c0e]">

        {/* Gateway header */}
        <div className="px-4 py-3 border-b border-white/5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Fleet Gateway</p>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pollError ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`} />
            <p className="text-[10px] font-mono text-gray-500 truncate">10.61.6.87:8080</p>
          </div>
        </div>

        {/* Poll error banner */}
        {pollError && (
          <div className="mx-3 mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] leading-relaxed">
            {pollError}
          </div>
        )}

        {/* Robot list */}
        <div className="flex-1 overflow-y-auto py-2">
          <p className="px-4 mb-1 text-[10px] font-bold uppercase tracking-widest text-gray-600">Robots</p>
          {robots.length === 0 && !pollError && (
            <div className="px-4 py-3 flex items-center gap-2 text-gray-600 text-xs">
              <Loader2 size={12} className="animate-spin" /> Scanning…
            </div>
          )}
          {robots.map(r => {
            const active = r.name === selectedName;
            const online = r.connectionStatus === 'ONLINE';
            return (
              <button
                key={r.name}
                onClick={() => { setSelectedName(r.name); onRobotChange?.(r.name); }}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors ${
                  active
                    ? 'bg-blue-600/15 border-r-2 border-blue-500 text-white'
                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                }`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${online ? 'bg-green-400' : 'bg-gray-600'}`} />
                <span className="text-xs font-bold font-mono">{r.name}</span>
              </button>
            );
          })}
        </div>

        {/* Selected robot status */}
        {selectedRobot && (
          <div className="border-t border-white/5 p-3 space-y-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mb-1.5">Connection</p>
              <ConnectionBadge status={selectedRobot.connectionStatus} />
            </div>
            <div>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mb-1.5">Action</p>
              <ActionBadge status={selectedRobot.lastActionStatus} />
            </div>
            {selectedRobot.mobileBaseState?.pose && (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mb-1">Pose</p>
                <div className="grid grid-cols-3 gap-1">
                  {(['x', 'y', 'a'] as const).map(axis => (
                    <div key={axis} className="bg-white/5 rounded px-1.5 py-1 text-center">
                      <p className="text-[8px] text-gray-600 uppercase">{axis}</p>
                      <p className="text-[10px] font-mono text-gray-300 tabular-nums">
                        {selectedRobot.mobileBaseState!.pose[axis].toFixed(2)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          CENTER — Action cards (scrollable)
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 overflow-y-auto flex flex-col">

        {/* ── Simulation Mode banner ──────────────────────────────────────── */}
        <div className={`flex-shrink-0 flex items-center justify-between px-5 py-2.5 border-b border-white/5 transition-colors ${simMode ? 'bg-amber-500/10' : 'bg-[#0f0f11]'}`}>
          <div className="flex items-center gap-2">
            <FlaskConical size={13} className={simMode ? 'text-amber-400' : 'text-gray-600'} />
            <span className={`text-xs font-bold uppercase tracking-widest ${simMode ? 'text-amber-400' : 'text-gray-600'}`}>
              Simulation Mode
            </span>
            {simMode && (
              <span className="text-[10px] text-amber-500/70 ml-1">
                — mutations are intercepted, no hardware commands sent
              </span>
            )}
          </div>
          <button
            onClick={() => setSimMode(v => !v)}
            className="flex items-center gap-2 transition"
            aria-label={simMode ? 'Disable simulation mode' : 'Enable simulation mode'}
          >
            {simMode
              ? <ToggleRight size={26} className="text-amber-400" />
              : <ToggleLeft  size={26} className="text-gray-600"  />}
          </button>
        </div>

        <div className="p-5 space-y-4 flex-1">
          {!selectedRobot && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-600 select-none">
              <Radio size={36} className="opacity-20" />
              <p className="text-sm">No robot selected</p>
            </div>
          )}

          {selectedRobot && (
            <>
              {/* ── A. Navigation ───────────────────────────────────────────── */}
              <SectionCard title="Navigation" icon={<MapPin size={14} />} accent="border-blue-500/20">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <FieldLabel>Target Waypoint</FieldLabel>
                    <input
                      type="text"
                      value={waypoint}
                      onChange={e => setWaypoint(e.target.value)}
                      placeholder="e.g. Q119"
                      list="waypoint-presets"
                      className={inputCls}
                      onKeyDown={e => e.key === 'Enter' && handleTravel()}
                    />
                    <datalist id="waypoint-presets">
                      {['Q100','Q101','Q110','Q111','Q119','Q120','Q200','Q300'].map(q => (
                        <option key={q} value={q} />
                      ))}
                    </datalist>
                  </div>
                  <div className="flex items-end">
                    <button
                      onClick={handleTravel}
                      disabled={!waypoint.trim() || !!loading['travel']}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      {loading['travel'] ? <Spinner /> : <Play size={12} fill="currentColor" />}
                      Go to Waypoint
                    </button>
                  </div>
                </div>
              </SectionCard>

              {/* ── B. Task Builder ─────────────────────────────────────────── */}
              <SectionCard title="Task Builder — Pick & Delivery" icon={<Package size={14} />} accent="border-amber-500/20">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>Pickup Node</FieldLabel>
                    <input
                      type="text"
                      value={pickupAlias}
                      onChange={e => setPickupAlias(e.target.value)}
                      placeholder="e.g. S3C2L2"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <FieldLabel>Delivery Node</FieldLabel>
                    <input
                      type="text"
                      value={deliveryAlias}
                      onChange={e => setDeliveryAlias(e.target.value)}
                      placeholder="e.g. S2C3L1"
                      className={inputCls}
                    />
                  </div>
                </div>
                {(pickupAlias || deliveryAlias) && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-gray-500 font-mono bg-white/5 px-3 py-2 rounded-lg">
                    <Package size={11} className="text-amber-400 flex-shrink-0" />
                    <span className="text-amber-400">{pickupAlias || '?'}</span>
                    <ChevronRight size={11} />
                    <Package size={11} className="text-blue-400 flex-shrink-0" />
                    <span className="text-blue-400">{deliveryAlias || '?'}</span>
                    <span className="ml-auto text-gray-600">via {selectedName}</span>
                  </div>
                )}
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={handleDispatch}
                    disabled={!pickupAlias.trim() || !deliveryAlias.trim() || !!loading['dispatch']}
                    className="flex items-center gap-2 px-5 py-2 rounded-lg text-xs font-bold bg-amber-600 hover:bg-amber-500 text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {loading['dispatch'] ? <Spinner /> : <Play size={12} fill="currentColor" />}
                    Dispatch Task
                  </button>
                </div>
              </SectionCard>

              {/* ── C. Recovery & Management ─────────────────────────────────── */}
              <SectionCard title="Recovery & Management" icon={<AlertTriangle size={14} />} accent="border-red-500/20">
                <div className="space-y-4">

                  {/* Row 1: CLEAR ERROR + CANCEL ALL */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <FieldLabel>Error Recovery</FieldLabel>
                      <button
                        onClick={handleClearError}
                        disabled={(!isError && !simMode) || !!loading['clearError']}
                        title={!isError && !simMode ? `Active only in ERROR state (current: ${selectedRobot.lastActionStatus})` : 'Clear robot error state'}
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold border transition disabled:opacity-30 disabled:cursor-not-allowed bg-red-600/20 hover:bg-red-600/40 text-red-400 border-red-500/40 disabled:hover:bg-red-600/20"
                      >
                        {loading['clearError'] ? <Spinner /> : <AlertTriangle size={13} />}
                        CLEAR ERROR
                      </button>
                      {!isError && !simMode && (
                        <p className="text-[9px] text-gray-600 mt-1 text-center">Active only in ERROR state</p>
                      )}
                    </div>
                    <div>
                      <FieldLabel>Job Control</FieldLabel>
                      <button
                        onClick={handleCancelAll}
                        disabled={!!loading['cancelAll']}
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold border transition disabled:opacity-40 disabled:cursor-not-allowed bg-orange-600/20 hover:bg-orange-600/40 text-orange-400 border-orange-500/40"
                      >
                        {loading['cancelAll'] ? <Spinner /> : <Ban size={13} />}
                        CANCEL ALL JOBS
                      </button>
                    </div>
                  </div>

                  {/* Row 2: Free Cell */}
                  <div>
                    <FieldLabel>Reset Cell</FieldLabel>
                    <div className="flex gap-2">
                      <select
                        value={cellIndex}
                        onChange={e => setCellIndex(Number(e.target.value))}
                        className={selectCls}
                        style={{ flex: '0 0 120px' }}
                      >
                        {[0, 1, 2, 3].map(i => <option key={i} value={i}>Cell {i}</option>)}
                      </select>
                      <button
                        onClick={handleFreeCell}
                        disabled={!!loading['freeCell']}
                        className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold border border-white/10 bg-white/5 hover:bg-white/10 text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {loading['freeCell'] ? <Spinner /> : <Layers size={13} />}
                        Free Cell {cellIndex}
                      </button>
                    </div>
                  </div>

                  {/* Row 3: Autorun toggle */}
                  <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-white/5 bg-white/3">
                    <div>
                      <p className="text-xs font-bold text-gray-300">Autorun</p>
                      <p className="text-[10px] text-gray-600 mt-0.5">Automatically process queued jobs</p>
                    </div>
                    <button
                      onClick={() => handleAutorun(!autorunOn)}
                      disabled={!!loading['autorun']}
                      className="flex items-center gap-2 transition disabled:opacity-40"
                      aria-label={autorunOn ? 'Disable autorun' : 'Enable autorun'}
                    >
                      {loading['autorun'] ? (
                        <Loader2 size={22} className="animate-spin text-gray-500" />
                      ) : autorunOn ? (
                        <ToggleRight size={28} className="text-green-400" />
                      ) : (
                        <ToggleLeft  size={28} className="text-gray-600"  />
                      )}
                      <span className={`text-xs font-bold ${autorunOn ? 'text-green-400' : 'text-gray-500'}`}>
                        {autorunOn ? 'ON' : 'OFF'}
                      </span>
                    </button>
                  </div>

                </div>
              </SectionCard>
            </>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          RIGHT PANEL — Job Queue + System Log
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="w-80 flex-shrink-0 border-l border-white/5 bg-[#0c0c0e] flex flex-col overflow-hidden">

        {/* ── Job Queue header ──────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <Inbox size={13} className="text-gray-500" />
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Job Queue</p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-700" />
            <span className="text-[9px] text-gray-600 font-mono">{POLL_MS / 1000}s</span>
            <button
              onClick={() => void pollRobots()}
              title="Refresh now"
              className="p-1 rounded text-gray-600 hover:text-gray-300 hover:bg-white/5 transition"
            >
              <RefreshCw size={10} />
            </button>
          </div>
        </div>

        {/* ── Job list ──────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {!selectedRobot && (
            <div className="flex flex-col items-center justify-center h-full text-gray-700 text-xs gap-2">
              <Inbox size={24} className="opacity-20" />
              <span>Select a robot</span>
            </div>
          )}

          {selectedRobot && (() => {
            type TaggedJob = GQLJob & { isCurrent: boolean };
            const current  = selectedRobot.currentJob;
            const allJobs: TaggedJob[] = [
              ...(current ? [{ ...current, isCurrent: true }] : []),
              ...(selectedRobot.jobQueue ?? []).map(j => ({ ...j, isCurrent: false })),
            ];

            if (allJobs.length === 0) {
              return (
                <div className="flex flex-col items-center justify-center h-full text-gray-700 gap-2">
                  <CheckCircle2 size={24} className="opacity-20" />
                  <span className="text-xs">Queue is empty</span>
                </div>
              );
            }

            return (
              <div className="py-3 px-3 space-y-2">
                {allJobs.map((job, idx) => {
                  const cancelKey     = `cancelJob-${job.uuid}`;
                  const isCancelling  = !!loading[cancelKey];
                  const isCancelled   = job.status === 'CANCELLED';

                  return (
                    <div
                      key={job.uuid}
                      className={`relative flex gap-3 p-3 rounded-lg border transition ${
                        job.isCurrent
                          ? 'bg-blue-500/10 border-blue-500/30'
                          : isCancelled
                            ? 'bg-white/2 border-white/3 opacity-50'
                            : 'bg-white/3 border-white/5'
                      }`}
                    >
                      {/* Timeline connector */}
                      {idx < allJobs.length - 1 && (
                        <span className="absolute left-[22px] top-full h-2 w-px bg-white/10" />
                      )}

                      {/* Left: status dot + op icon */}
                      <div className="flex flex-col items-center gap-1 pt-0.5 flex-shrink-0">
                        <JobStatusDot status={job.status} />
                        <OperationIcon op={job.operation} />
                      </div>

                      {/* Right: details */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1 mb-0.5">
                          <span className={`text-[10px] font-bold uppercase tracking-wider ${job.isCurrent ? 'text-blue-400' : 'text-gray-500'}`}>
                            {job.isCurrent ? 'Current' : `Queue #${idx}`}
                          </span>
                          <JobStatusPill status={job.status} />
                        </div>
                        <p className="text-xs font-bold text-gray-200">{job.operation}</p>
                        {job.targetNode?.alias && (
                          <p className="text-[10px] text-gray-500 font-mono mt-0.5 flex items-center gap-1">
                            <MapPin size={9} /> {job.targetNode.alias}
                          </p>
                        )}
                        <p className="text-[9px] text-gray-700 font-mono mt-1 truncate" title={job.uuid}>
                          {job.uuid.slice(0, 8)}…
                        </p>

                        {/* Cancel button — hidden for already-cancelled jobs */}
                        {!isCancelled && (
                          <button
                            onClick={() => handleCancelJob(job.uuid)}
                            disabled={isCancelling}
                            className="mt-2 flex items-center gap-1 px-2 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 text-[10px] font-bold transition disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {isCancelling
                              ? <Loader2 size={9} className="animate-spin" />
                              : <X        size={9} />}
                            {isCancelling ? 'Cancelling…' : 'Cancel'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* ══════════════════════════════════════════════════════════════════
            SYSTEM LOG — collapsible, auto-scrolling, 200-entry ring buffer
        ══════════════════════════════════════════════════════════════════ */}
        <div className={`flex-shrink-0 border-t border-white/5 flex flex-col transition-all ${logOpen ? 'h-64' : 'h-9'}`}>

          {/* Log toolbar */}
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/5 flex-shrink-0">
            <Terminal size={11} className={simMode ? 'text-amber-500' : 'text-gray-500'} />
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 flex-1">
              System Log
            </span>

            {/* Introspect quick-fire buttons */}
            <button
              onClick={() => void handleIntrospect('Robot')}
              disabled={!!loading['introspect']}
              title="Introspect Robot GQL type"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 border border-white/5 hover:border-blue-500/30 transition disabled:opacity-40"
            >
              <Search size={9} /> Robot
            </button>
            <button
              onClick={() => void handleIntrospect('RobotCell')}
              disabled={!!loading['introspect']}
              title="Introspect RobotCell GQL type"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono text-gray-500 hover:text-amber-400 hover:bg-amber-500/10 border border-white/5 hover:border-amber-500/30 transition disabled:opacity-40"
            >
              <Search size={9} /> RobotCell
            </button>

            {/* Clear log */}
            <button
              onClick={() => setLogs([])}
              title="Clear log"
              className="p-1 rounded text-gray-700 hover:text-gray-400 hover:bg-white/5 transition"
            >
              <X size={10} />
            </button>

            {/* Collapse/expand */}
            <button
              onClick={() => setLogOpen(o => !o)}
              className="p-1 rounded text-gray-600 hover:text-gray-300 hover:bg-white/5 transition"
            >
              {logOpen ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
            </button>
          </div>

          {/* Log entries */}
          {logOpen && (
            <div className="flex-1 overflow-y-auto font-mono text-[10px] leading-relaxed">
              {logs.length === 0 && (
                <p className="px-3 py-2 text-gray-700 italic">No entries yet — waiting for first poll…</p>
              )}
              {logs.map(entry => (
                <div
                  key={entry.id}
                  className={`px-3 py-1.5 border-b border-white/3 ${
                    entry.level === 'error' ? 'bg-red-500/5    text-red-400'    :
                    entry.level === 'warn'  ? 'bg-amber-500/5  text-amber-400'  :
                    entry.level === 'sim'   ? 'bg-amber-500/8  text-amber-300'  :
                    entry.level === 'ok'    ? 'text-green-400/70'               :
                                              'text-gray-500'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-gray-700">{entry.ts}</span>
                    <span className={`font-bold uppercase ${
                      entry.level === 'error' ? 'text-red-500'    :
                      entry.level === 'warn'  ? 'text-amber-500'  :
                      entry.level === 'sim'   ? 'text-amber-400'  :
                      entry.level === 'ok'    ? 'text-green-500'  :
                                                'text-blue-500'
                    }`}>
                      [{entry.level === 'sim' ? 'SIM' : entry.level.toUpperCase()}]
                    </span>
                    <span className="text-gray-400">{entry.label}</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-all text-[9px] opacity-80 max-h-32 overflow-y-auto">
                    {entry.body}
                  </pre>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>

      </div>
    </div>
  );
};

export default FleetControlPanel;
