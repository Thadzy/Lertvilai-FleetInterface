/**
 * Fleet Socket Hook - Production-Grade MQTT Connection Manager
 * =============================================================
 * 
 * This hook provides a robust, type-safe interface for MQTT communication
 * with the Fleet Gateway and robot simulators.
 * 
 * Features:
 * - Explicit connection state machine (Connected/Disconnected/Reconnecting)
 * - Exponential backoff reconnection strategy
 * - Thread-safe robot status batching to reduce re-renders
 * - Strict TypeScript typing throughout
 * - Proper cleanup on unmount
 * 
 * @author WCS Team
 * @version 2.0.0
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import mqtt, { type MqttClient } from 'mqtt';

// ============================================
// CONFIGURATION
// ============================================

/** MQTT Broker WebSocket URL */
const BROKER_URL = import.meta.env.VITE_MQTT_BROKER_URL || 'ws://broker.emqx.io:8083/mqtt';

/** Initial reconnect delay in milliseconds */
const INITIAL_RECONNECT_DELAY_MS = 1000;

/** Maximum reconnect delay (cap for exponential backoff) */
const MAX_RECONNECT_DELAY_MS = 30000;

/** Backoff multiplier for each failed attempt */
const BACKOFF_MULTIPLIER = 2;

/** Debounce interval for batching robot status updates (ms) */
const STATUS_UPDATE_BATCH_INTERVAL_MS = 100;

// ============================================
// TYPE DEFINITIONS
// ============================================

/**
 * Possible states for the MQTT connection.
 * Using a discriminated union for type-safe state handling.
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Standard robot status message structure from MQTT.
 * Matches the Python simulator's output format.
 */
export interface RobotStatusMessage {
    /** Robot unique identifier */
    id: string | number;
    /** Current operational status */
    status: 'idle' | 'busy' | 'offline' | 'error';
    /** Battery level percentage (0-100) */
    battery: number;
    /** X coordinate in meters */
    x: number;
    /** Y coordinate in meters */
    y: number;
    /** Heading angle in radians (optional) */
    angle?: number;
    /** Currently assigned task ID, if any */
    current_task_id?: number | null;
}

/**
 * Log message from the Fleet Gateway.
 */
export interface FleetLogMessage {
    /** Log message text */
    msg: string;
    /** Unix timestamp */
    timestamp: number;
}

/**
 * Robot command payload for publishing.
 */
export interface RobotCommand {
    command: 'GOTO' | 'PAUSE' | 'RESUME' | 'ESTOP';
    target_x?: number;
    target_y?: number;
    timestamp: number;
}

/**
 * Return type for the useFleetSocket hook.
 */
export interface UseFleetSocketReturn {
    /** Current connection status */
    connectionStatus: ConnectionStatus;
    /** Whether currently connected (convenience boolean) */
    isConnected: boolean;
    /** Map of robot IDs to their latest status */
    robotStates: Readonly<Record<string, RobotStatusMessage>>;
    /** Recent log messages from the Gateway (newest first) */
    logs: readonly string[];
    /** Number of reconnection attempts since last successful connection */
    reconnectAttempts: number;
    /** Publish a command to a specific robot */
    publishCommand: (robotId: number | string, command: RobotCommand['command'], payload?: Partial<RobotCommand>) => void;
    /** Manually trigger a reconnection attempt */
    forceReconnect: () => void;
    /** Add a local log message to the log list (useful for simulation or UI events) */
    addLog: (msg: string) => void;
}

// ============================================
// HOOK IMPLEMENTATION
// ============================================

/**
 * Production-grade MQTT connection hook with exponential backoff.
 * 
 * @example
 * ```tsx
 * const { connectionStatus, robotStates, publishCommand } = useFleetSocket();
 * 
 * // Send a command
 * publishCommand(1, 'PAUSE');
 * 
 * // Access robot data
 * const robot1 = robotStates['1'];
 * ```
 */
export const useFleetSocket = (): UseFleetSocketReturn => {
    // --- STATE ---
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
    const [robotStates, setRobotStates] = useState<Record<string, RobotStatusMessage>>({});
    const [logs, setLogs] = useState<string[]>([]);
    const [reconnectAttempts, setReconnectAttempts] = useState(0);

    // --- REFS (for values accessed in callbacks without causing re-subscriptions) ---
    const clientRef = useRef<MqttClient | null>(null);
    const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingUpdatesRef = useRef<Record<string, RobotStatusMessage>>({});
    const batchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isMountedRef = useRef(true);

    /**
     * Flush pending robot status updates to state.
     * This batches multiple 10Hz updates into a single re-render.
     */
    const flushPendingUpdates = useCallback(() => {
        if (!isMountedRef.current) return;

        const pending = pendingUpdatesRef.current;
        if (Object.keys(pending).length > 0) {
            setRobotStates(prev => ({ ...prev, ...pending }));
            pendingUpdatesRef.current = {};
        }
        batchTimeoutRef.current = null;
    }, []);

    /**
     * Schedule a batched update.
     * If multiple updates come in within BATCH_INTERVAL, they are merged.
     */
    const scheduleUpdate = useCallback((robotId: string, status: RobotStatusMessage) => {
        pendingUpdatesRef.current[robotId] = status;

        if (!batchTimeoutRef.current) {
            batchTimeoutRef.current = setTimeout(flushPendingUpdates, STATUS_UPDATE_BATCH_INTERVAL_MS);
        }
    }, [flushPendingUpdates]);

    /**
     * Calculate reconnection delay with exponential backoff.
     */
    const getReconnectDelay = useCallback((attempt: number): number => {
        const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
        return Math.min(delay, MAX_RECONNECT_DELAY_MS);
    }, []);

    /**
     * Handle incoming MQTT messages.
     */
    const handleMessage = useCallback((topic: string, message: Buffer) => {
        try {
            const payload = JSON.parse(message.toString());

            // Handle Fleet Logs
            if (topic === 'fleet/logs') {
                const logMessage = (payload as FleetLogMessage).msg || 'Unknown Event';
                setLogs(prev => [logMessage, ...prev].slice(0, 50)); // Keep last 50
                return;
            }

            // Handle Robot Status: robots/{id}/status
            const parts = topic.split('/');
            if (parts.length >= 3 && parts[2] === 'status') {
                const robotId = parts[1];
                const statusMessage = payload as RobotStatusMessage;

                // Use batched updates to reduce re-renders
                scheduleUpdate(robotId, statusMessage);
            }
        } catch (err) {
            console.error('[FleetSocket] Message parse error:', err);
        }
    }, [scheduleUpdate]);

    /**
     * Establish MQTT connection.
     */
    const connect = useCallback(() => {
        if (clientRef.current?.connected) return;

        setConnectionStatus('connecting');
        console.log(`[FleetSocket] Connecting to ${BROKER_URL}...`);

        const client = mqtt.connect(BROKER_URL, {
            clientId: `fleet_ui_${Math.random().toString(16).substring(2, 8)}`,
            keepalive: 60,
            clean: true,
            reconnectPeriod: 0, // We handle reconnection manually with exponential backoff
            connectTimeout: 10000,
        });

        client.on('connect', () => {
            if (!isMountedRef.current) return;

            console.log('[FleetSocket] Connected successfully ✅');
            setConnectionStatus('connected');
            setReconnectAttempts(0);

            // Subscribe to topics
            client.subscribe(['robots/+/status', 'fleet/logs'], { qos: 1 }, (err) => {
                if (err) {
                    console.error('[FleetSocket] Subscription error:', err);
                } else {
                    console.log('[FleetSocket] Subscribed to robot status and fleet logs');
                }
            });
        });

        client.on('message', handleMessage);

        client.on('close', () => {
            if (!isMountedRef.current) return;

            console.log('[FleetSocket] Connection closed');
            setConnectionStatus('disconnected');
        });

        client.on('offline', () => {
            if (!isMountedRef.current) return;

            console.log('[FleetSocket] Offline - will attempt reconnection');
            setConnectionStatus('reconnecting');

            // Schedule reconnection with exponential backoff
            const delay = getReconnectDelay(reconnectAttempts);
            console.log(`[FleetSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);

            reconnectTimeoutRef.current = setTimeout(() => {
                if (!isMountedRef.current) return;
                setReconnectAttempts(prev => prev + 1);
                connect();
            }, delay);
        });

        client.on('error', (err) => {
            console.error('[FleetSocket] Connection error:', err);
            // Don't end the client here - let the 'offline' handler manage reconnection
        });

        clientRef.current = client;
    }, [handleMessage, getReconnectDelay, reconnectAttempts]);

    /**
     * Publish a command to a robot.
     */
    const publishCommand = useCallback((
        robotId: number | string,
        command: RobotCommand['command'],
        payload: Partial<RobotCommand> = {}
    ) => {
        const client = clientRef.current;

        if (!client || !client.connected) {
            console.warn('[FleetSocket] Cannot publish: not connected');
            return;
        }

        const topic = `robots/${robotId}/command`;
        const message: RobotCommand = {
            command,
            timestamp: Date.now(),
            ...payload,
        };

        client.publish(topic, JSON.stringify(message), { qos: 1 }, (err) => {
            if (err) {
                console.error(`[FleetSocket] Publish error to ${topic}:`, err);
            } else {
                console.log(`[FleetSocket] Sent ${command} to Robot ${robotId}`);
            }
        });
    }, []);

    /**
     * Force a reconnection attempt.
     */
    const forceReconnect = useCallback(() => {
        if (clientRef.current) {
            clientRef.current.end(true);
            clientRef.current = null;
        }
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
        }
        setReconnectAttempts(0);
        connect();
    }, [connect]);

    /**
     * Add a local UI log message.
     */
    const addLog = useCallback((msg: string) => {
        setLogs(prev => [msg, ...prev].slice(0, 50));
    }, []);

    // --- LIFECYCLE ---
    useEffect(() => {
        isMountedRef.current = true;
        connect();

        return () => {
            isMountedRef.current = false;

            // Cleanup pending updates
            if (batchTimeoutRef.current) {
                clearTimeout(batchTimeoutRef.current);
            }

            // Cleanup reconnection timeout
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }

            // Disconnect MQTT client
            if (clientRef.current) {
                console.log('[FleetSocket] Disconnecting...');
                clientRef.current.end();
                clientRef.current = null;
            }
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // --- DERIVED STATE ---
    const isConnected = connectionStatus === 'connected';

    // Memoize the return object to prevent unnecessary re-renders in consumers
    return useMemo(() => ({
        connectionStatus,
        isConnected,
        robotStates,
        logs,
        reconnectAttempts,
        publishCommand,
        forceReconnect,
        addLog,
    }), [connectionStatus, isConnected, robotStates, logs, reconnectAttempts, publishCommand, forceReconnect, addLog]);
};

export default useFleetSocket;
