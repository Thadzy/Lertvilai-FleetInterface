/**
 * AnimatedEdge — Bezier edge with an optional CSS-animated flowing dash overlay.
 *
 * Two `<path>` elements are rendered:
 *   1. A solid base stroke with the configured colour + arrow marker.
 *   2. A dashed overlay that flows via `.animated-edge-flow` (index.css)
 *      **only when the `animated` prop is true**.
 *
 * This keeps idle base-graph edges visually quiet (static Bezier curve) while
 * making active paths / sim routes clearly animated.
 *
 * Register in React Flow:
 * ```tsx
 * import AnimatedEdge from './edges/AnimatedEdge';
 * const edgeTypes = { animatedEdge: AnimatedEdge };
 * ```
 *
 * @module AnimatedEdge
 */
import React from 'react';
import { getStraightPath, type EdgeProps } from 'reactflow';

/**
 * Custom straight edge with conditional flowing-dash animation.
 * Uses straight lines (not Bezier curves) to accurately represent
 * the physical paths robots travel between warehouse waypoints.
 *
 * @param props - Standard ReactFlow EdgeProps (source/target coords, style, animated flag, etc.)
 */
const AnimatedEdge: React.FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style = {},
  markerEnd,
  animated,
}) => {
  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY });

  // Pull stroke colour + width from the style prop with safe defaults.
  const stroke = (style as React.CSSProperties & { stroke?: string }).stroke ?? '#38bdf8';
  const strokeWidth = (style as React.CSSProperties & { strokeWidth?: number }).strokeWidth ?? 2;

  return (
    <>
      {/* ① Base solid path — carries the arrow marker */}
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        style={{ ...style, fill: 'none', stroke, strokeWidth }}
        markerEnd={markerEnd}
      />

      {/* ② Flowing dash overlay — visible only when edge is animated */}
      {animated && (
        <path
          d={edgePath}
          className="animated-edge-flow"
          style={{
            fill: 'none',
            stroke,
            strokeWidth: strokeWidth * 0.75,
            strokeDasharray: '12 8',
            opacity: 0.8,
            pointerEvents: 'none',
          }}
        />
      )}
    </>
  );
};

export default AnimatedEdge;
