/**
 * @file Sidebar.tsx
 * @description Node properties panel for the warehouse map editor.
 *   Displays editable fields for the selected React Flow node and shows the
 *   node's position converted to ROS real-world coordinates (meters).
 */

import React from 'react';
import { Edit3, CircleDot, ArrowUpFromLine, Box, Trash2, Plus, MapPin } from 'lucide-react';
import { Node } from 'reactflow';
import { Level } from '../../hooks/useGraphData';
import { toRosCoordinates } from '../../utils/mapCoordinates';
import type { RosMapConfig } from '../../hooks/useMapConfig';

// ============================================================
// PROP TYPES
// ============================================================

interface SidebarProps {
  selectedNode: Node | null;
  onUpdateNode: (key: string, value: any) => void;
  onSetAsDepot: (nodeId: number, label: string) => void;
  levels: Level[];
  shelfCells: any[];
  onDeleteCell: (id: number) => void;
  newCellCol: string;
  setNewCellCol: (val: string) => void;
  newCellLevel: string;
  setNewCellLevel: (val: string) => void;
  onCreateCell: () => void;
  /** ROS map config from useMapConfig; drives the coordinate conversion display. */
  mapConfig: RosMapConfig;
}

// ============================================================
// SHARED INPUT CLASS
// ============================================================

/** Tailwind class string shared by all text/number inputs in this panel. */
const inputClass =
  'text-xs border border-slate-300 dark:border-white/10 rounded px-2 py-1 ' +
  'focus:outline-none focus:border-blue-500 bg-white dark:bg-[#09090b] ' +
  'text-gray-900 dark:text-white font-mono';

/** Tailwind class string for read-only display fields. */
const readonlyInputClass =
  'text-xs border border-slate-200 dark:border-white/5 rounded px-2 py-1 ' +
  'bg-gray-50 dark:bg-[#0e0e10] text-gray-500 dark:text-gray-400 font-mono ' +
  'cursor-default select-all';

// ============================================================
// COMPONENT
// ============================================================

/**
 * Sidebar panel rendered in the top-right corner of the map editor when a node
 * is selected.
 *
 * Responsibilities:
 *   - Editable label and node-type fields.
 *   - Node-type-specific fields (conveyor height, yaw, shelf cell grid).
 *   - Read-only ROS world coordinates derived from the node's canvas position.
 *   - "Set as Depot" action for eligible node types.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  selectedNode, onUpdateNode, onSetAsDepot, levels,
  shelfCells, onDeleteCell, newCellCol, setNewCellCol,
  newCellLevel, setNewCellLevel, onCreateCell, mapConfig,
}) => {
  if (!selectedNode || selectedNode.id === 'map-background') return null;

  const isShelf    = selectedNode.data.type === 'shelf';
  const isDepot    = selectedNode.data.type === 'depot';
  const isCell     = selectedNode.data.type === 'cell';
  const isConveyor = selectedNode.data.type === 'conveyor';
  const isWaypoint = selectedNode.data.type === 'waypoint';

  /**
   * Whether this node type carries a meaningful orientation (yaw).
   * Shelves are axis-aligned by convention; cells have no independent pose.
   */
  const hasYaw = isWaypoint || isConveyor || isDepot;

  /**
   * Convert the node's React Flow canvas position to ROS real-world meters.
   * `selectedNode.position` holds the top-left corner of the node in canvas pixels.
   */
  const rosCoords = toRosCoordinates(
    selectedNode.position.x,
    selectedNode.position.y,
    mapConfig,
  );

  return (
    <div className="bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-blue-200 dark:border-white/10 shadow-xl rounded-xl p-3 flex flex-col gap-2 w-64 animate-in slide-in-from-right-4 pointer-events-auto">

      {/* ---- PANEL HEADER ---- */}
      <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400 border-b border-blue-100 dark:border-white/5 pb-2 mb-1">
        <Edit3 size={14} />
        <span className="text-xs font-bold uppercase">Node Properties</span>
      </div>

      {/* ---- LABEL ---- */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase">
          Label
        </label>
        <input
          type="text"
          value={selectedNode.data.label}
          onChange={(e) => onUpdateNode('label', e.target.value)}
          className={inputClass}
          disabled={isDepot || isCell}
        />
      </div>

      {/* ---- NODE TYPE ---- */}
      {!isDepot && !isCell && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase">
            Type
          </label>
          <select
            value={selectedNode.data.type || 'waypoint'}
            onChange={(e) => onUpdateNode('type', e.target.value)}
            className="text-xs border border-slate-300 dark:border-white/10 rounded px-2 py-1 focus:outline-none focus:border-blue-500 bg-white dark:bg-[#121214] text-gray-900 dark:text-white"
          >
            <option value="waypoint">Waypoint</option>
            <option value="conveyor">Conveyor</option>
            <option value="shelf">Shelf</option>
          </select>
        </div>
      )}

      {/* ---- YAW (orientation in radians) ---- */}
      {/*
        Yaw is the rotation of the node around the vertical axis, expressed
        in radians. The robot uses this value to face the correct direction
        when arriving at a waypoint, conveyor, or depot.
        Range: -PI to +PI  (0 = facing East / positive X direction in ROS).
      */}
      {hasYaw && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase">
            Yaw (rad)
          </label>
          <input
            type="number"
            step="0.01"
            min={-Math.PI}
            max={Math.PI}
            value={selectedNode.data.yaw ?? 0}
            onChange={(e) => onUpdateNode('yaw', parseFloat(e.target.value) || 0)}
            className={inputClass}
          />
        </div>
      )}

      {/* ---- ROS WORLD COORDINATES (read-only) ---- */}
      {/*
        These values are computed from the node's React Flow canvas position
        using the map YAML metadata (resolution + origin).
        They are read-only because the source of truth is the canvas position;
        editing them here would require an inverse transform that is out of scope.

        Map config in use:
          resolution  : {mapConfig.resolution} m/px
          origin      : ({mapConfig.originX}, {mapConfig.originY})
          image height: {mapConfig.imgHeight} px
      */}
      <div className="border-t border-gray-100 dark:border-white/5 pt-2 mt-1 flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase">
          <MapPin size={10} />
          ROS World Coordinates
        </div>

        <div className="grid grid-cols-2 gap-2">
          {/* Real-world X */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-gray-400 uppercase">
              X (m)
            </label>
            <input
              type="text"
              readOnly
              value={rosCoords.x.toFixed(3)}
              className={readonlyInputClass}
              title="Real-world X coordinate in meters (ROS frame)"
            />
          </div>

          {/* Real-world Y */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-gray-400 uppercase">
              Y (m)
            </label>
            <input
              type="text"
              readOnly
              value={rosCoords.y.toFixed(3)}
              className={readonlyInputClass}
              title="Real-world Y coordinate in meters (ROS frame)"
            />
          </div>
        </div>

        {/* Canvas pixel position — useful for debugging alignment */}
        <p className="text-[9px] text-gray-400 dark:text-gray-600 font-mono leading-tight">
          canvas ({Math.round(selectedNode.position.x)}, {Math.round(selectedNode.position.y)}) px
        </p>
      </div>

      {/* ---- SET AS DEPOT ---- */}
      {!isNaN(Number(selectedNode.id)) && (isWaypoint || isConveyor) && (
        <button
          onClick={() => onSetAsDepot(Number(selectedNode.id), selectedNode.data.label)}
          className="mt-1 flex items-center justify-center gap-2 px-3 py-1.5 bg-red-600/90 text-white text-[10px] font-bold rounded hover:bg-red-700 shadow-sm transition-all active:translate-y-0.5"
        >
          <CircleDot size={12} />
          SET AS DEPOT
        </button>
      )}

      {/* ---- STATUS BADGES ---- */}
      {isDepot && (
        <div className="text-[10px] text-red-500 font-bold bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded border border-red-100 dark:border-red-900/30">
          Depot — Primary charging and parking station
        </div>
      )}
      {isCell && (
        <div className="text-[10px] text-purple-500 font-bold bg-purple-50 dark:bg-purple-900/20 px-2 py-1 rounded border border-purple-100 dark:border-purple-900/30">
          Cell — Managed via parent shelf grid
        </div>
      )}

      {/* ---- CONVEYOR HEIGHT ---- */}
      {isConveyor && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase flex items-center gap-1">
            <ArrowUpFromLine size={10} /> Height (m)
          </label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={selectedNode.data.height ?? 1.0}
            onChange={(e) => onUpdateNode('height', parseFloat(e.target.value) || 0)}
            className={inputClass}
          />
        </div>
      )}

      {/* ---- SHELF CELL GRID ---- */}
      {isShelf && (
        <div className="border-t border-gray-200 dark:border-white/10 pt-2 mt-1">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-cyan-600 uppercase flex items-center gap-1">
              <Box size={10} /> Cells in Grid
            </span>
          </div>

          {/* Cell list */}
          <div className="max-h-48 overflow-y-auto pr-1 flex flex-col gap-1">
            {shelfCells.length === 0 && (
              <p className="text-[10px] text-gray-500 italic">No cells assigned</p>
            )}
            {shelfCells.map((cell) => (
              <div
                key={cell.id}
                className="flex items-center justify-between py-1 px-2 text-[10px] bg-gray-50 dark:bg-white/5 rounded border border-transparent hover:border-blue-200 dark:hover:border-blue-900/30 transition-all"
              >
                <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                  {cell.alias}
                </span>
                <span className="text-purple-500 font-bold">
                  {cell.levelAlias || '?'}
                </span>
                <button
                  onClick={() => onDeleteCell(cell.id)}
                  className="text-red-400 hover:text-red-600 transition-colors"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </div>

          {/* Add cell form */}
          {levels.length > 0 ? (
            <div className="mt-2 pt-2 border-t border-gray-100 dark:border-white/5 flex flex-col gap-1.5">
              <div className="flex gap-1">
                <input
                  type="number"
                  placeholder="Col"
                  value={newCellCol}
                  onChange={(e) => setNewCellCol(e.target.value)}
                  min="1"
                  className="w-14 text-[10px] px-2 py-1 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-[#09090b] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500"
                />
                <select
                  value={newCellLevel}
                  onChange={(e) => setNewCellLevel(e.target.value)}
                  className="flex-1 text-[10px] px-1 py-1 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-[#09090b] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">Level...</option>
                  {levels.map((l) => (
                    <option key={l.id} value={l.id}>{l.alias}</option>
                  ))}
                </select>
                <button
                  onClick={onCreateCell}
                  disabled={!newCellLevel}
                  className="px-2 py-1 bg-cyan-600 text-white rounded hover:bg-cyan-700 disabled:opacity-40"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[9px] text-amber-500 mt-1 italic">
              Define levels in the Level Manager first
            </p>
          )}
        </div>
      )}
    </div>
  );
};
