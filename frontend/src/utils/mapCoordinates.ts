/**
 * @file mapCoordinates.ts
 * @description Pure utility for converting React Flow canvas coordinates to
 *   ROS (Robot Operating System) real-world coordinates in meters.
 *
 * This module contains no hard-coded map configuration.  All spatial metadata
 * (resolution, origin, image dimensions) must be supplied by the caller via a
 * `RosMapConfig` object — typically sourced from the `useMapConfig` hook, which
 * reads and writes these values to the `wh_graphs` database table.
 *
 * Axis conventions:
 *   React Flow  — origin at top-left,    Y increases downward  (screen space)
 *   ROS         — origin at bottom-left, Y increases upward    (world space)
 *   .pgm image  — origin at top-left,    row 0 is the HIGHEST Y in world space
 *
 * Because React Flow and ROS Y-axes point in opposite directions, a raw
 * canvas Y value cannot be used in the ROS formula directly.  It must first
 * be mirrored against the image height so that "top of canvas" maps to
 * "top of map image" (the highest Y value in ROS world coordinates).
 */

import type { RosMapConfig } from '../hooks/useMapConfig';

// Re-export the type so consumers can import from a single location.
export type { RosMapConfig };

// ============================================================
// RESULT TYPE
// ============================================================

/**
 * Real-world coordinate pair in the ROS map frame (meters).
 */
export interface RosCoordinates {
  /** Distance east of the map origin in meters (positive = right on the map). */
  x: number;
  /** Distance north of the map origin in meters (positive = up on the map). */
  y: number;
}

// ============================================================
// CONVERSION FUNCTION
// ============================================================

/**
 * Converts a React Flow canvas position to ROS real-world coordinates in meters.
 *
 * Conversion steps:
 *   1. X-axis: multiply canvas X by the map resolution to convert to metres,
 *              then add the real-world X origin offset.
 *
 *   2. Y-axis (inverted):
 *      a. Subtract the canvas Y from the image height (in canvas pixels) to
 *         flip the direction — React Flow Y=0 (top) becomes the highest world Y.
 *      b. Multiply the flipped value by the resolution to convert to metres.
 *      c. Add the real-world Y origin offset.
 *
 * Formulas:
 *   realX     = originX + (rfX * resolution)
 *   invertedY = imgHeight - rfY
 *   realY     = originY + (invertedY * resolution)
 *
 * Note on `imgHeight` units:
 *   `config.imgHeight` is the height of the source .pgm image in its ORIGINAL
 *   pixels.  Because nodes are stored in metres and scaled by SCALE_FACTOR=100
 *   when rendered on the canvas, the caller should supply rfX/rfY as the raw
 *   `selectedNode.position` values from React Flow (canvas pixels = DB_metres * 100).
 *   `imgHeight` in the config should therefore also be in canvas pixels:
 *     config.imgHeight = pgm_pixel_height * config.resolution * 100
 *   The `useMapConfig` hook and the upload handler compute this automatically
 *   when the user uploads a .pgm file.
 *
 * @param rfX    - Node X position in React Flow canvas pixels
 *                 (`selectedNode.position.x`).
 * @param rfY    - Node Y position in React Flow canvas pixels
 *                 (`selectedNode.position.y`).
 * @param config - ROS map metadata from `useMapConfig`.
 * @returns `RosCoordinates` with `x` and `y` in metres, each at 3 decimal places.
 *
 * @example
 * const ros = toRosCoordinates(350, 200, config);
 * // => { x: 10.730, y: -9.200 }
 */
export function toRosCoordinates(
  rfX: number,
  rfY: number,
  config: RosMapConfig
): RosCoordinates {
  const { resolution, originX, originY, imgHeight } = config;

  // X-axis: RF X and ROS X both increase in the same (rightward) direction.
  const realX = originX + rfX * resolution;

  // Y-axis inversion:
  //   In React Flow (and in the .pgm raster), Y=0 is at the TOP.
  //   In ROS world space, Y=0 is at the BOTTOM.
  //   Subtracting rfY from imgHeight reflects the coordinate so that:
  //     rfY = 0          ->  invertedY = imgHeight  (top of image -> high world Y)
  //     rfY = imgHeight  ->  invertedY = 0          (bottom of image -> low world Y)
  const invertedY = imgHeight - rfY;
  const realY     = originY + invertedY * resolution;

  return {
    x: parseFloat(realX.toFixed(3)),
    y: parseFloat(realY.toFixed(3)),
  };
}
