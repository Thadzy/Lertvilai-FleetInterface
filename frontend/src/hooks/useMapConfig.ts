/**
 * @file useMapConfig.ts
 * @description React hook that manages the ROS map coordinate configuration
 *   for a specific warehouse graph.  Configuration is persisted in the
 *   `wh_graphs` table (columns: map_res, map_origin_x, map_origin_y,
 *   map_img_height) so that every user/device sees the same values.
 *
 * Configuration fields and their role in coordinate conversion:
 *   - resolution  : meters per pixel of the source .pgm file.
 *   - originX     : real-world X (m) of the map image's bottom-left corner.
 *   - originY     : real-world Y (m) of the map image's bottom-left corner.
 *   - imgHeight   : pixel height of the source .pgm; used to invert the Y-axis
 *                   so that ROS Y increases upward while React Flow Y goes down.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

// ============================================================
// TYPES
// ============================================================

/**
 * ROS map coordinate configuration, derived from the warehouse YAML file
 * and the source .pgm image dimensions.
 */
export interface RosMapConfig {
  /** Meters per pixel of the source .pgm map image (from YAML `resolution`). */
  resolution: number;
  /** Real-world X coordinate (m) of the map image's bottom-left corner (from YAML `origin[0]`). */
  originX: number;
  /** Real-world Y coordinate (m) of the map image's bottom-left corner (from YAML `origin[1]`). */
  originY: number;
  /** Pixel height of the source .pgm image; required for Y-axis inversion. */
  imgHeight: number;
}

// ============================================================
// DEFAULTS
// ============================================================

/**
 * Fallback configuration used when a graph has no saved map config.
 * These match the YAML values of the initial warehouse map.
 */
export const DEFAULT_ROS_MAP_CONFIG: RosMapConfig = {
  resolution: 0.05,
  originX: -6.77,
  originY: -19.2,
  imgHeight: 1000,
};

// ============================================================
// DB COLUMN MAP
// DB column names differ from the camelCase config keys.
// ============================================================

interface DbMapConfigRow {
  map_res:        number | null;
  map_origin_x:   number | null;
  map_origin_y:   number | null;
  map_img_height: number | null;
}

/** Converts a DB row to a RosMapConfig, filling gaps with defaults. */
function rowToConfig(row: DbMapConfigRow): RosMapConfig {
  return {
    resolution: row.map_res        ?? DEFAULT_ROS_MAP_CONFIG.resolution,
    originX:    row.map_origin_x   ?? DEFAULT_ROS_MAP_CONFIG.originX,
    originY:    row.map_origin_y   ?? DEFAULT_ROS_MAP_CONFIG.originY,
    imgHeight:  row.map_img_height ?? DEFAULT_ROS_MAP_CONFIG.imgHeight,
  };
}

/** Converts a RosMapConfig to the DB column shape. */
function configToRow(cfg: RosMapConfig): DbMapConfigRow {
  return {
    map_res:        cfg.resolution,
    map_origin_x:   cfg.originX,
    map_origin_y:   cfg.originY,
    map_img_height: cfg.imgHeight,
  };
}

// ============================================================
// HOOK
// ============================================================

/**
 * Manages the ROS map configuration for a single warehouse graph.
 *
 * Usage:
 * ```tsx
 * const { config, updateConfig, configLoading } = useMapConfig(graphId);
 * ```
 *
 * @param graphId - The numeric ID of the warehouse graph row in `wh_graphs`.
 * @returns
 *   - `config`        — Current `RosMapConfig` (defaults until DB load completes).
 *   - `updateConfig`  — Async function to persist partial or full config updates.
 *   - `configLoading` — True while the initial DB fetch is in progress.
 */
export function useMapConfig(graphId: number) {
  const [config,        setConfig]        = useState<RosMapConfig>(DEFAULT_ROS_MAP_CONFIG);
  const [configLoading, setConfigLoading] = useState(true);

  // ---- Load from DB on mount / graphId change ----
  useEffect(() => {
    if (!graphId) return;

    let cancelled = false;
    setConfigLoading(true);

    const load = async () => {
      const { data, error } = await supabase
        .from('wh_graphs')
        .select('map_res, map_origin_x, map_origin_y, map_img_height')
        .eq('id', graphId)
        .single();

      if (cancelled) return;

      if (error) {
        console.error('[useMapConfig] Failed to load map config:', error.message);
      } else if (data) {
        setConfig(rowToConfig(data as DbMapConfigRow));
      }

      setConfigLoading(false);
    };

    load();
    return () => { cancelled = true; };
  }, [graphId]);

  // ---- Persist updates to DB ----

  /**
   * Merges `updates` into the current config and writes all four columns to
   * `wh_graphs`.  Returns the updated config so callers can chain operations.
   *
   * @param updates - Partial `RosMapConfig`; only the provided keys are changed.
   * @returns The resulting full `RosMapConfig` after the merge.
   */
  const updateConfig = useCallback(
    async (updates: Partial<RosMapConfig>): Promise<RosMapConfig> => {
      const merged = { ...config, ...updates };
      // Optimistic local update — keeps the UI responsive.
      setConfig(merged);

      const { error } = await supabase
        .from('wh_graphs')
        .update(configToRow(merged))
        .eq('id', graphId);

      if (error) {
        console.error('[useMapConfig] Failed to save map config:', error.message);
        // Roll back to the last known good state on failure.
        setConfig(config);
        throw error;
      }

      return merged;
    },
    [config, graphId]
  );

  return { config, updateConfig, configLoading };
}
