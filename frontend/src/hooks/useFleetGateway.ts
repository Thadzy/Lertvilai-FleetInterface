/**
 * useFleetGateway — Shared React hook for direct Fleet Gateway communication
 * ===========================================================================
 * Polls /api/robot-gw/graphql (Vite proxy → http://10.61.6.87:8080) for live
 * robot telemetry and exposes typed mutation helpers.
 *
 * Called ONCE in FleetInterface.tsx and its return values are passed as props
 * to child tabs, ensuring Tab 2 (Optimization) and Tab 3 (FleetController)
 * always see an identical robot snapshot without duplicate polling.
 *
 * Simulation Mode
 * ───────────────
 * When `simMode` is true every mutation short-circuits to simulateMut():
 *   - A 500 ms artificial delay fires
 *   - A synthetic success result is returned
 *   - No network traffic is produced
 * The polling loop continues so live telemetry is still visible in demo mode.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GW         = '/api/robot-gw/graphql';
const POLL_MS    = 2_000;
const SIM_DELAY  = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Public types  (imported by Optimization, FleetController, FleetInterface)
// ─────────────────────────────────────────────────────────────────────────────

export interface GQLRobot {
  name: string;
  /** ONLINE | OFFLINE */
  connectionStatus: string;
  /** IDLE | OPERATING | ERROR */
  lastActionStatus: string;
  mobileBaseState?: {
    pose: { x: number; y: number; a: number };
  } | null;
  currentJob?: {
    uuid: string;
    status: string;
    operation: string;
    targetNode?: { alias: string } | null;
  } | null;
  jobQueue?: {
    uuid: string;
    status: string;
    operation: string;
  }[] | null;
}

export interface RequestOrderResult {
  success: boolean;
  message: string;
  request?: { uuid: string; status: string } | null;
}

/** One step in the 4-stage Hard Reset sequence. */
export interface HardResetProgress {
  stepId: 'cancel_current' | 'clean_queue' | 'clear_error' | 'verify';
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

export interface UseFleetGatewayReturn {
  robots: GQLRobot[];
  connected: boolean;
  pollError: string | null;
  refresh: () => Promise<void>;
  /**
   * The robot currently selected by the operator.
   * Auto-populated from the first robot returned by the gateway on initial
   * connect, and can be updated via `setActiveRobotName`.
   */
  activeRobotName: string;
  /**
   * Updates the globally active robot.  Call this from the Robot Selector UI
   * whenever the operator switches focus to a different physical unit.
   */
  setActiveRobotName: (name: string) => void;
  /** Dispatches a pick-and-deliver task to a named robot. */
  dispatchRequest: (
    robotName: string,
    pickupAlias: string,
    deliveryAlias: string,
  ) => Promise<RequestOrderResult>;
  /**
   * Runs the 4-step Hard Reset sequence and streams progress via `onProgress`.
   * Steps continue on individual failures so the reset is as complete as
   * possible even when one mutation rejects (best-effort recovery).
   */
  hardReset: (
    robotName: string,
    onProgress: (steps: HardResetProgress[]) => void,
  ) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// GQL transport — thin fetch wrapper
// ─────────────────────────────────────────────────────────────────────────────

async function gqlFetch<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GW, {
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

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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
      jobQueue   { uuid status operation }
    }
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useFleetGateway(simMode: boolean): UseFleetGatewayReturn {
  const [robots,           setRobots]           = useState<GQLRobot[]>([]);
  const [connected,        setConnected]        = useState(false);
  const [pollError,        setPollError]        = useState<string | null>(null);
  /**
   * Name of the robot currently focused by the operator.
   * Starts empty; auto-populated from the first robot the gateway returns.
   * Updated externally via `setActiveRobotName` (Robot Selector UI).
   */
  const [activeRobotName,  setActiveRobotName]  = useState<string>('');

  // Keep a ref so interval closures always read the latest simMode value
  // without needing to restart the interval on every toggle.
  const simRef = useRef(simMode);
  useEffect(() => { simRef.current = simMode; }, [simMode]);

  // ── Polling ──────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const data = await gqlFetch<{ robots: GQLRobot[] }>(ROBOTS_QUERY);
      const fetched = data.robots ?? [];
      setRobots(fetched);
      setConnected(true);
      setPollError(null);
      // Auto-select the first robot on the initial successful fetch.
      // Uses the functional form so the effect is idempotent on subsequent polls.
      if (fetched.length > 0) {
        setActiveRobotName(prev => prev || fetched[0].name);
      }
    } catch (err) {
      setConnected(false);
      setPollError(err instanceof Error ? err.message : 'Cannot reach gateway');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // ── dispatchRequest ───────────────────────────────────────────────────────
  const dispatchRequest = useCallback(async (
    robotName: string,
    pickupAlias: string,
    deliveryAlias: string,
  ): Promise<RequestOrderResult> => {
    if (simRef.current) {
      await delay(SIM_DELAY);
      return {
        success: true,
        message: `[SIMULATION] sendRequestOrder acknowledged`,
        request: { uuid: `sim-${Date.now()}`, status: 'QUEUING' },
      };
    }
    const data = await gqlFetch<{ sendRequestOrder: RequestOrderResult }>(
      `mutation SendRequestOrder($robotName: String!, $pickupAlias: String!, $deliveryAlias: String!) {
         sendRequestOrder(requestOrder: {
           robotName: $robotName
           requestAlias: {
             pickupNodeAlias: $pickupAlias
             deliveryNodeAlias: $deliveryAlias
           }
         }) { success message request { uuid status } }
       }`,
      { robotName, pickupAlias, deliveryAlias },
    );
    return data.sendRequestOrder;
  }, []);

  // ── hardReset ─────────────────────────────────────────────────────────────
  /**
   * Four-step reset sequence derived from the verified Python recovery script:
   *
   *   Step 1 — cancelCurrentJob(robotName)
   *   Step 2 — query jobs { uuid status }, cancelJobs(uuids: [active UUIDs])
   *   Step 3 — clearRobotError(robotName)          [mandatory to reach IDLE]
   *   Step 4 — re-query robot, verify lastActionStatus === 'IDLE'
   *
   * Progress is streamed via onProgress(steps[]) so the caller can render a
   * live stepper without waiting for the full sequence to complete.
   */
  const hardReset = useCallback(async (
    robotName: string,
    onProgress: (steps: HardResetProgress[]) => void,
  ) => {
    const steps: HardResetProgress[] = [
      { stepId: 'cancel_current', label: 'Cancel Current Job',  status: 'pending' },
      { stepId: 'clean_queue',    label: 'Clean Active Queue',  status: 'pending' },
      { stepId: 'clear_error',    label: 'Clear Error State',   status: 'pending' },
      { stepId: 'verify',         label: 'Verify IDLE Status',  status: 'pending' },
    ];

    /** Mutate a step in-place and notify the caller. */
    const push = (idx: number, patch: Partial<HardResetProgress>) => {
      steps[idx] = { ...steps[idx], ...patch };
      onProgress([...steps]);
    };

    console.log(`[HardReset] Starting 4-step recovery for robot: ${robotName}`);

    // ── Step 1: Cancel Current Job ────────────────────────────────────────
    // Non-fatal in all cases — if the robot is already IDLE it has no current
    // job and the mutation will error; treat that as "already done".
    push(0, { status: 'running', detail: `Calling cancelCurrentJob(${robotName})…` });
    if (simRef.current) {
      await delay(SIM_DELAY);
      push(0, { status: 'done', detail: '[SIM] cancelCurrentJob acknowledged' });
    } else {
      try {
        const d = await gqlFetch<{ cancelCurrentJob: { uuid: string; status: string } }>(
          `mutation CancelCurrent($name: String!) {
             cancelCurrentJob(robotName: $name) { uuid status }
           }`,
          { name: robotName },
        );
        const short = d.cancelCurrentJob.uuid.slice(0, 8);
        push(0, {
          status: 'done',
          detail: `Cancelled job ${short}… → ${d.cancelCurrentJob.status}`,
        });
        console.log(`[HardReset] Step 1 OK — job ${short}… cancelled`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "No active job" / "not found" means the robot was already IDLE — not an error.
        const alreadyIdle = /no active job|no current job|not found|nothing to cancel/i.test(msg);
        push(0, {
          status: 'done',       // always mark done so sequence continues
          detail: alreadyIdle
            ? `Already IDLE — skipping cancel (server: ${msg})`
            : `Non-fatal: ${msg}`,
        });
        console.warn(`[HardReset] Step 1 non-fatal (${alreadyIdle ? 'already idle' : 'unexpected'}): ${msg}`);
      }
    }

    // ── Step 2: Query all jobs, cancel active ones ────────────────────────
    // Queries the full jobs list, filters for QUEUING or IN_PROGRESS,
    // then issues cancelJobs([...uuids]) in a single mutation.
    push(1, { status: 'running', detail: 'Querying active job queue…' });
    if (simRef.current) {
      await delay(SIM_DELAY);
      push(1, { status: 'done', detail: '[SIM] Queue cleared (0 jobs found)' });
    } else {
      try {
        const jobsData = await gqlFetch<{ jobs: { uuid: string; status: string }[] }>(
          `query GetAllJobs { jobs { uuid status } }`,
        );
        const allJobs    = jobsData.jobs ?? [];
        const activeUuids = allJobs
          .filter(j => j.status === 'QUEUING' || j.status === 'IN_PROGRESS')
          .map(j => j.uuid);

        console.log(`[HardReset] Step 2 — found ${allJobs.length} total jobs, ${activeUuids.length} active`);

        if (activeUuids.length > 0) {
          const cancelled = await gqlFetch<{ cancelJobs: { uuid: string; status: string }[] }>(
            `mutation CancelJobs($uuids: [UUID!]!) { cancelJobs(uuids: $uuids) { uuid status } }`,
            { uuids: activeUuids },
          );
          const results = (cancelled.cancelJobs ?? [])
            .map(j => `${j.uuid.slice(0, 6)}…→${j.status}`)
            .join(', ');
          push(1, {
            status: 'done',
            detail: `Cancelled ${activeUuids.length} job(s): ${results}`,
          });
          console.log(`[HardReset] Step 2 OK — cancelled: ${results}`);
        } else {
          push(1, { status: 'done', detail: 'No active jobs in queue — already clean' });
          console.log('[HardReset] Step 2 OK — queue already empty');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        push(1, { status: 'failed', detail: msg });
        console.error(`[HardReset] Step 2 failed: ${msg}`);
      }
    }

    // ── Step 3: Clear Error State ─────────────────────────────────────────
    // Mandatory call to move the robot back to IDLE.
    push(2, { status: 'running', detail: `Calling clearRobotError(${robotName})…` });
    if (simRef.current) {
      await delay(SIM_DELAY);
      push(2, { status: 'done', detail: '[SIM] clearRobotError acknowledged' });
    } else {
      try {
        await gqlFetch(
          `mutation ClearErr($name: String!) { clearRobotError(robotName: $name) }`,
          { name: robotName },
        );
        push(2, { status: 'done', detail: 'clearRobotError accepted' });
        console.log('[HardReset] Step 3 OK — clearRobotError accepted');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        push(2, { status: 'failed', detail: msg });
        console.error(`[HardReset] Step 3 failed: ${msg}`);
      }
    }

    // ── Step 4: Verify IDLE Status ────────────────────────────────────────
    // Wait for the backend to propagate state, then re-query and assert IDLE.
    push(3, { status: 'running', detail: 'Waiting for state propagation…' });
    await delay(800);
    if (simRef.current) {
      await delay(SIM_DELAY);
      push(3, { status: 'done', detail: '[SIM] lastActionStatus: IDLE · currentJob: null' });
    } else {
      try {
        const data = await gqlFetch<{ robots: GQLRobot[] }>(ROBOTS_QUERY);
        const allRobots = data.robots ?? [];

        // Case-insensitive lookup so "localbot" / "LOCALBOT" / "LocalBot" all match.
        const bot = allRobots.find(r => r.name.toUpperCase() === robotName.toUpperCase());

        if (bot) {
          // New, less strict success condition:
          // 1. No active job (currentJob is null)
          // 2. lastActionStatus is a "safe" state: IDLE, SUCCEEDED, CANCELED, or COMPLETED.
          const safeStates = ['IDLE', 'SUCCEEDED', 'CANCELED', 'COMPLETED'];
          const statusUpper = (bot.lastActionStatus || '').toUpperCase();
          const isSafeStatus = safeStates.includes(statusUpper);
          const hasNoJob = !bot.currentJob;
          const ok = isSafeStatus && hasNoJob;

          const jobInfo = bot.currentJob
            ? `${bot.currentJob.uuid.slice(0, 8)}… (${bot.currentJob.status})`
            : 'null';
          
          push(3, {
            status: ok ? 'done' : 'failed',
            detail: ok 
              ? `Ready (Status: ${bot.lastActionStatus})` 
              : `lastActionStatus: ${bot.lastActionStatus} · currentJob: ${jobInfo}`,
          });
          console.log(`[HardReset] Step 4 ${ok ? 'OK ✓' : 'FAILED ✗'} — status: ${bot.lastActionStatus}, job: ${jobInfo}`);
          // Sync shared robots state immediately with fresh data.
          setRobots(allRobots);
        } else {
          const available = allRobots.map(r => `"${r.name}"`).join(', ') || '(empty)';
          push(3, {
            status: 'failed',
            detail: `Robot "${robotName}" not found. Available: [${available}]`,
          });
          console.error(
            `[HardReset] Step 4 FAILED — robot "${robotName}" not in response.\n` +
            `Available robots: ${available}\n` +
            `Full response:`, JSON.stringify(data, null, 2),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        push(3, { status: 'failed', detail: msg });
        console.error(`[HardReset] Step 4 failed: ${msg}`);
      }
    }

    console.log(`[HardReset] Sequence complete for ${robotName}`);
  }, []);

  return { robots, connected, pollError, refresh, activeRobotName, setActiveRobotName, dispatchRequest, hardReset };
}
