import { useState, useEffect, useRef } from 'react';
import { type DBNode, type DBEdge } from '../types/database';

/**
 * Interface for the public robot data used by the UI.
 */
export interface RobotStatus {
  id: string;
  x: number;
  y: number;
  battery: number;
  status: 'IDLE' | 'MOVING' | 'ERROR' | 'CHARGING';
  current_task?: string;
}

/**
 * Internal Interface for the simulation state.
 * Extends RobotStatus with simulation-specific fields (target, progress).
 */
interface SimulatedRobot extends RobotStatus {
  targetNode?: DBNode; // The node the robot is currently moving toward
}

/**
 * HOOK: useRobotSimulation
 * * Generates a "Ghost Fleet" of robots for testing the UI without real hardware.
 * * Simulates movement, battery drain, and status updates at 20 ticks/second.
 * * @param nodes - The list of warehouse nodes (waypoints).
 * @param edges - The list of valid paths (currently unused in simple flight mode).
 * @returns Array of RobotStatus objects for rendering.
 */
export const useRobotSimulation = (nodes: DBNode[], edges: DBEdge[]) => {
  // React State for rendering
  const [robots, setRobots] = useState<RobotStatus[]>([]);
  
  // Mutable Ref to hold state between renders without triggering re-renders (Performance)
  // FIX: Replaced 'any' with 'SimulatedRobot[]' for strict typing
  const robotStateRef = useRef<SimulatedRobot[]>([]);

  // =========================================================
  // 1. INITIALIZATION
  // =========================================================
  useEffect(() => {
    if (nodes.length === 0) return;

    // Create 3 Simulated Robots spawning at random nodes
    const initialRobots: SimulatedRobot[] = ['R-01', 'R-02', 'R-03'].map(id => {
      const randomNode = nodes[Math.floor(Math.random() * nodes.length)];
      return {
        id,
        x: randomNode.x * 100, // Scale to pixels (1m = 100px)
        y: randomNode.y * 100,
        battery: 80 + Math.floor(Math.random() * 20), // Random battery 80-100%
        status: 'IDLE',
      };
    });

    // Update the ref immediately so the animation loop can pick it up
    robotStateRef.current = initialRobots;

    // FIX: "Cascading Render" Warning
    // We wrap the state update in a timeout to push it to the next event loop tick.
    // This allows the current render to finish before triggering the re-render for robots.
    const timer = setTimeout(() => {
      setRobots(initialRobots);
    }, 0);

    return () => clearTimeout(timer);
  }, [nodes]);

  // =========================================================
  // 2. ANIMATION LOOP (GAME LOOP)
  // =========================================================
  useEffect(() => {
    if (nodes.length === 0) return;

    const TICK_RATE_MS = 50; // Update every 50ms (~20 FPS)

    const interval = setInterval(() => {
      // Update position of every robot based on simulation logic
      robotStateRef.current = robotStateRef.current.map(robot => {
        
        // CASE A: Robot is IDLE -> Assign a new random target
        if (robot.status === 'IDLE') {
           const target = nodes[Math.floor(Math.random() * nodes.length)];
           return { 
             ...robot, 
             status: 'MOVING', 
             targetNode: target 
           };
        }

        // CASE B: Robot is MOVING -> Calculate next step
        if (robot.status === 'MOVING' && robot.targetNode) {
          const targetX = robot.targetNode.x * 100;
          const targetY = robot.targetNode.y * 100;

          const dx = targetX - robot.x;
          const dy = targetY - robot.y;
          const distanceToTarget = Math.sqrt(dx*dx + dy*dy);
          const speed = 5; // Pixels per tick (Increased speed for visibility)

          // Check if arrived (within snap distance)
          if (distanceToTarget < 5) {
             return { 
               ...robot, 
               x: targetX, 
               y: targetY, 
               status: 'IDLE',
               targetNode: undefined 
             };
          } else {
             // Move closer by 'speed' pixels
             return { 
               ...robot, 
               x: robot.x + (dx / distanceToTarget) * speed, 
               y: robot.y + (dy / distanceToTarget) * speed 
             };
          }
        }
        
        return robot;
      });

      // Push the new state to React to trigger a re-render
      // We spread [...array] to create a new reference, forcing React to notice the change
      setRobots([...robotStateRef.current]);

    }, TICK_RATE_MS);

    // Cleanup interval on unmount
    return () => clearInterval(interval);
  }, [nodes, edges]);

  return robots;
};