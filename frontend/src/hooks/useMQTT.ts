import { useEffect, useState, useCallback, useRef } from 'react';
import mqtt, { type MqttClient } from 'mqtt';

// --- CONFIGURATION ---
// We use a public WebSocket broker for testing.
// In production, this would be an environment variable (e.g., process.env.VITE_MQTT_BROKER_URL)
const BROKER_URL = 'ws://broker.emqx.io:8083/mqtt';

// Standard Robot Status Message Structure
export interface RobotStatusMessage {
    id: string | number;
    status: 'idle' | 'busy' | 'offline' | 'error';
    battery: number;
    x: number;
    y: number;
    angle?: number;
    current_task_id?: number | null;
}

export const useMQTT = () => {
    const [client, setClient] = useState<MqttClient | null>(null);
    const [isConnected, setIsConnected] = useState(false);

    // Real-time Map of Robot Statuses (Key = Robot ID)
    const [robotStates, setRobotStates] = useState<Record<string, RobotStatusMessage>>({});

    // Ref to avoid closure staleness in callbacks
    const robotStatesRef = useRef<Record<string, RobotStatusMessage>>({});

    // Logs Cache
    const [logs, setLogs] = useState<string[]>([]);

    useEffect(() => {
        console.log("[MQTT] Hook Loaded - V2 (Port 8083)");
        console.log(`[MQTT] Connecting to ${BROKER_URL}...`);

        const mqttClient = mqtt.connect(BROKER_URL, {
            clientId: `fleet_interface_${Math.random().toString(16).substring(2, 8)}`,
            keepalive: 60,
            clean: true,
            reconnectPeriod: 2000, // Retry every 2s
            connectTimeout: 30 * 1000,
        });

        mqttClient.on('connect', () => {
            console.log('[MQTT] Connected successfully.');
            setIsConnected(true);

            // Subscribe to robots status AND fleet logs
            mqttClient.subscribe(['robots/+/status', 'fleet/logs'], (err) => {
                if (err) console.error('[MQTT] Subscription error:', err);
                else console.log('[MQTT] Subscribed to robots/+/status and fleet/logs');
            });
        });

        mqttClient.on('reconnect', () => {
            console.log('[MQTT] Reconnecting...');
        });

        mqttClient.on('close', () => {
            console.log('[MQTT] Connection closed.');
            setIsConnected(false);
        });

        mqttClient.on('message', (topic, message) => {
            // Debug: Log all traffic
            console.log(`[MQTT RECV] ${topic}`);

            try {
                // Handle Logs
                if (topic === 'fleet/logs') {
                    const payload = JSON.parse(message.toString());
                    const msg = payload.msg || "Unknown Event";
                    setLogs(prev => [msg, ...prev].slice(0, 50)); // Keep last 50
                    return;
                }

                // Handle Robot Status
                // robots/101/status
                const parts = topic.split('/');
                const robotId = parts[1];
                const type = parts[2];

                if (type === 'status') {
                    const payload = JSON.parse(message.toString()) as RobotStatusMessage;
                    console.log(`[MQTT] Status Update for ${robotId}: x=${payload.x}, y=${payload.y}, status=${payload.status}`);

                    setRobotStates((prev) => {
                        const next = { ...prev, [robotId]: payload };
                        robotStatesRef.current = next;
                        return next;
                    });
                }
            } catch (err) {
                console.error('[MQTT] Message Parse Error:', err);
            }
        });

        mqttClient.on('error', (err) => {
            console.error('[MQTT] Connection Detailed Error:', err);
            mqttClient.end();
        });

        mqttClient.on('offline', () => {
            console.log('[MQTT] Offline');
            setIsConnected(false);
        });

        setClient(mqttClient);

        return () => {
            console.log('[MQTT] Disconnecting...');
            mqttClient.end();
        };
    }, []);

    /**
     * Helper to publish a command to a specific robot
     */
    const publishCommand = useCallback((robotId: number | string, command: string, payload: any = {}) => {
        if (!client || !isConnected) {
            console.warn('[MQTT] Cannot publish: Client not connected');
            return;
        }

        const topic = `robots/${robotId}/command`;
        const message = JSON.stringify({ command, ...payload, timestamp: Date.now() });

        client.publish(topic, message, { qos: 1 }, (err) => {
            if (err) console.error(`[MQTT] Publish error to ${topic}:`, err);
            else console.log(`[MQTT] Sent ${command} to ${topic}`);
        });
    }, [client, isConnected]);

    return { isConnected, robotStates, logs, publishCommand, client };
};
