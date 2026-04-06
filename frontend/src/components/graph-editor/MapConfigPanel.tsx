/**
 * @file MapConfigPanel.tsx
 * @description Collapsible panel for editing the ROS map coordinate configuration
 *   directly in the warehouse map editor.
 *
 * Fields exposed:
 *   - Resolution (m/px)  — from the YAML `resolution` key.
 *   - Origin X (m)       — from the YAML `origin[0]` key.
 *   - Origin Y (m)       — from the YAML `origin[1]` key.
 *   - Image Height (px)  — height of the source .pgm in canvas pixels;
 *                          auto-populated on upload; adjustable manually.
 *
 * Persistence strategy:
 *   Changes are written to Supabase (`wh_graphs`) on field blur, so the DB is
 *   not hit on every keystroke.  The parent component is notified via
 *   `onConfigChange` immediately (optimistic local state), but the DB write is
 *   performed here via the `updateConfig` prop.
 */

import React, { useState, useEffect } from 'react';
import { Settings, ChevronDown, ChevronUp, Info } from 'lucide-react';
import type { RosMapConfig } from '../../hooks/useMapConfig';

// ============================================================
// PROPS
// ============================================================

interface MapConfigPanelProps {
  /** Current saved configuration (read from DB via useMapConfig). */
  config: RosMapConfig;
  /**
   * Persist a partial config update to Supabase.
   * Mirrors the signature of `useMapConfig.updateConfig`.
   */
  updateConfig: (updates: Partial<RosMapConfig>) => Promise<RosMapConfig>;
  /** Whether the initial DB load is still in progress. */
  loading: boolean;
}

// ============================================================
// SHARED STYLES
// ============================================================

const labelClass =
  'text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide';

const inputClass =
  'text-xs border border-slate-300 dark:border-white/10 rounded px-2 py-1 ' +
  'focus:outline-none focus:border-blue-500 bg-white dark:bg-[#09090b] ' +
  'text-gray-900 dark:text-white font-mono w-full';

// ============================================================
// COMPONENT
// ============================================================

/**
 * Expandable panel rendered in the top-left area of the map editor.
 * Allows the user to update the four ROS map metadata values that govern
 * real-world coordinate display in the Node Properties sidebar.
 */
export const MapConfigPanel: React.FC<MapConfigPanelProps> = ({
  config,
  updateConfig,
  loading,
}) => {
  const [expanded, setExpanded] = useState(false);

  /**
   * Local draft state — tracks what the user is currently typing.
   * Initialised from `config` so existing DB values are shown on first open.
   * Synced whenever `config` changes (e.g., after upload sets imgHeight).
   */
  const [draft, setDraft] = useState<RosMapConfig>(config);

  // Keep draft in sync when config is updated externally (e.g., after .pgm upload).
  useEffect(() => {
    setDraft(config);
  }, [config]);

  /**
   * Parses the latest draft value for a given key and persists it to Supabase.
   * Called on the `onBlur` event of each input to avoid a DB write per keystroke.
   *
   * @param key   - The `RosMapConfig` key being saved.
   * @param value - The raw string value from the input element.
   */
  const handleBlur = async (key: keyof RosMapConfig, value: string) => {
    const parsed = parseFloat(value);
    if (isNaN(parsed)) return; // Do not persist invalid input.

    const coerced = key === 'imgHeight' ? Math.round(parsed) : parsed;
    try {
      await updateConfig({ [key]: coerced });
    } catch {
      // updateConfig already logs — no additional handling needed here.
    }
  };

  /**
   * Handles keypress inside an input: blurs the element on Enter so that the
   * `onBlur` handler fires and the value is saved immediately.
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  };

  return (
    <div className="bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-gray-200 dark:border-white/10 shadow-sm rounded-xl overflow-hidden pointer-events-auto">

      {/* ---- Toggle Button ---- */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        title="ROS Map Configuration"
      >
        <Settings size={13} />
        <span className="text-[10px] font-bold uppercase tracking-wide flex-1 text-left">
          Map Config
        </span>
        {loading ? (
          <span className="text-[9px] text-gray-400 italic">loading...</span>
        ) : (
          <span className="text-[9px] font-mono text-gray-400">
            {config.resolution} m/px
          </span>
        )}
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {/* ---- Expandable Form ---- */}
      {expanded && (
        <div className="border-t border-gray-100 dark:border-white/5 p-3 flex flex-col gap-3">

          {/* Resolution */}
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Resolution (m / px)</label>
            <input
              type="number"
              step="0.001"
              min="0.001"
              value={draft.resolution}
              onChange={(e) => setDraft((d) => ({ ...d, resolution: parseFloat(e.target.value) || d.resolution }))}
              onBlur={(e) => handleBlur('resolution', e.target.value)}
              onKeyDown={handleKeyDown}
              className={inputClass}
            />
          </div>

          {/* Origin row: X and Y side-by-side */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Origin X (m)</label>
              <input
                type="number"
                step="0.01"
                value={draft.originX}
                onChange={(e) => setDraft((d) => ({ ...d, originX: parseFloat(e.target.value) }))}
                onBlur={(e) => handleBlur('originX', e.target.value)}
                onKeyDown={handleKeyDown}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Origin Y (m)</label>
              <input
                type="number"
                step="0.01"
                value={draft.originY}
                onChange={(e) => setDraft((d) => ({ ...d, originY: parseFloat(e.target.value) }))}
                onBlur={(e) => handleBlur('originY', e.target.value)}
                onKeyDown={handleKeyDown}
                className={inputClass}
              />
            </div>
          </div>

          {/* Image Height */}
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Image Height (canvas px)</label>
            <input
              type="number"
              step="1"
              min="1"
              value={draft.imgHeight}
              onChange={(e) => setDraft((d) => ({ ...d, imgHeight: parseInt(e.target.value, 10) || d.imgHeight }))}
              onBlur={(e) => handleBlur('imgHeight', e.target.value)}
              onKeyDown={handleKeyDown}
              className={inputClass}
            />
          </div>

          {/* Hint */}
          <div className="flex items-start gap-1.5 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded p-2">
            <Info size={10} className="text-blue-400 mt-0.5 shrink-0" />
            <p className="text-[9px] text-blue-500 dark:text-blue-400 leading-relaxed">
              Values are saved on field blur (or Enter).
              Upload a .pgm file to auto-set Image Height.
              Copy Resolution and Origin from your YAML file.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
