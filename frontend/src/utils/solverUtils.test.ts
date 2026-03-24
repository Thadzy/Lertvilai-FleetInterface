import { describe, it, expect } from 'vitest';
import { formatTasksForSolver, getDist, generateDistanceMatrix } from './solverUtils';
import { type DBNode, type DBEdge } from '../types/database';

describe('solverUtils', () => {
    describe('getDist', () => {
        it('calculates Euclidean distance correctly', () => {
            const nodeA: DBNode = { id: 1, alias: 'A', x: 0, y: 0, type: 'waypoint', graph_id: 1, a: 0, level: 1 };
            const nodeB: DBNode = { id: 2, alias: 'B', x: 3, y: 4, type: 'waypoint', graph_id: 1, a: 0, level: 1 };
            expect(getDist(nodeA, nodeB)).toBe(5);
        });
    });

    describe('generateDistanceMatrix', () => {
        it('generates a matrix with correct distances', () => {
            const nodes: DBNode[] = [
                { id: 1, alias: 'A', x: 0, y: 0, type: 'waypoint', graph_id: 1, a: 0, level: 1 },
                { id: 2, alias: 'B', x: 10, y: 0, type: 'waypoint', graph_id: 1, a: 0, level: 1 },
                { id: 3, alias: 'C', x: 10, y: 10, type: 'waypoint', graph_id: 1, a: 0, level: 1 }
            ];
            const edges: DBEdge[] = [
                { id: 1, node_a_id: 1, node_b_id: 2, graph_id: 1 },
                { id: 2, node_b_id: 3, node_a_id: 2, graph_id: 1 }
            ];

            const matrix = generateDistanceMatrix(nodes, edges);

            // 3 nodes -> 3x3 matrix
            expect(matrix.length).toBe(3);

            // A -> B (distance 10, scaled by 100 -> 1000)
            expect(matrix[0][1]).toBe(1000);

            // A -> C (indirect via B: 10 + 10 = 20, scaled -> 2000)
            expect(matrix[0][2]).toBe(2000);
        });
    });

    describe('formatTasksForSolver', () => {
        it('maps task names to node indices', () => {
            const nodes: DBNode[] = [
                { id: 1, alias: 'Depot', x: 0, y: 0, type: 'depot', graph_id: 1, a: 0, level: 1 },
                { id: 2, alias: 'Pickup', x: 10, y: 0, type: 'waypoint', graph_id: 1, a: 0, level: 1 },
                { id: 3, alias: 'Dropoff', x: 20, y: 0, type: 'waypoint', graph_id: 1, a: 0, level: 1 }
            ];

            const tasks = [
                { pickup_name: 'Pickup', delivery_name: 'Dropoff' }
            ];

            const result = formatTasksForSolver(tasks, nodes);
            // Expect [ [index of Pickup, index of Dropoff] ] -> [ [1, 2] ]
            expect(result).toEqual([[1, 2]]);
        });

        it('defaults to dummy indices if names found', () => {
            const nodes: DBNode[] = [
                { id: 1, alias: 'Depot', x: 0, y: 0, type: 'depot', graph_id: 1, a: 0, level: 1 }
            ];
            const tasks = [
                { pickup_name: 'Unknown', delivery_name: 'Nowhere' }
            ];
            // Implementation defaults to 1, 2
            const result = formatTasksForSolver(tasks, nodes);
            expect(result).toEqual([[1, 2]]);
        });
    });
});
