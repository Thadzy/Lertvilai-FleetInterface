import React, { useRef, useState, useEffect } from 'react';
import { 
  Undo2, Redo2, MousePointer2, Link as LinkIcon, 
  SquareDashedMousePointer, PlusCircle, ChevronDown, 
  CircleDot, ArrowUpFromLine, Box, Trash2, RefreshCw, Save,
  Upload, Lock, Unlock, XCircle
} from 'lucide-react';
import { useGraphStore } from '../../store/graphStore';

interface ToolbarProps {
  toolMode: 'move' | 'connect' | 'select';
  setToolMode: (mode: 'move' | 'connect' | 'select') => void;
  mapLocked: boolean;
  onMapLockToggle: () => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveBackground: () => void;
  bgUrl: string | null;
  onAddNode: (type: 'waypoint' | 'conveyor' | 'shelf') => void;
  onDeleteSelected: () => void;
  onReload: () => void;
  onSave: () => void;
  loading: boolean;
  undoDisabled: boolean;
  redoDisabled: boolean;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  toolMode, setToolMode, mapLocked, onMapLockToggle,
  onFileUpload, onRemoveBackground, bgUrl,
  onAddNode, onDeleteSelected, onReload, onSave,
  loading, undoDisabled, redoDisabled
}) => {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const { undo, redo } = useGraphStore();

  useEffect(() => {
    if (!showAddMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showAddMenu]);

  return (
    <div className="bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-gray-200 dark:border-white/10 shadow-lg rounded-xl p-1.5 flex gap-1 pointer-events-auto">
      <div className="flex gap-1 pr-2 border-r border-gray-200 dark:border-white/10 items-center">
        
        {/* Map Controls */}
        {bgUrl && (
          <>
            <button onClick={onRemoveBackground} className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all" title="Remove Map">
              <XCircle size={18} />
            </button>
            <button onClick={onMapLockToggle} className={`p-2 rounded-lg transition-all ${!mapLocked ? 'bg-amber-100 text-amber-600 shadow-sm' : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'}`} title={mapLocked ? "Unlock Map for Editing" : "Unlock Map"}>
              {mapLocked ? <Lock size={18} /> : <Unlock size={18} />}
            </button>
          </>
        )}

        <label
          className="cursor-pointer p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
          title="Upload Map (.pgm, .png, .jpg, .webp)"
        >
          {/* accept includes .pgm explicitly because it is not covered by image/* */}
          <input
            type="file"
            accept="image/*,.pgm"
            className="hidden"
            onChange={onFileUpload}
          />
          <Upload size={18} />
        </label>

        {/* Tool Switcher */}
        <button
          onClick={() => setToolMode('move')}
          className={`p-2 rounded-lg transition-all ${toolMode === 'move' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'}`}
          title="Move Tool"
        >
          <MousePointer2 size={18} />
        </button>

        <button
          onClick={() => setToolMode('connect')}
          className={`p-2 rounded-lg transition-all ${toolMode === 'connect' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'}`}
          title="Connect Tool"
        >
          <LinkIcon size={18} />
        </button>

        <button
          onClick={() => setToolMode('select')}
          className={`p-2 rounded-lg transition-all ${toolMode === 'select' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'}`}
          title="Select Tool"
        >
          <SquareDashedMousePointer size={18} />
        </button>

        <div className="w-px h-5 bg-gray-200 dark:bg-white/10 self-center mx-0.5" />

        <button
          onClick={undo}
          disabled={undoDisabled}
          className="p-2 rounded-lg transition-all text-slate-500 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={18} />
        </button>

        <button
          onClick={redo}
          disabled={redoDisabled}
          className="p-2 rounded-lg transition-all text-slate-500 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={18} />
        </button>

        {/* Add Node Dropdown */}
        <div className="relative" ref={addMenuRef}>
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all flex items-center gap-0.5"
            title="Add Node"
          >
            <PlusCircle size={18} />
            <ChevronDown size={10} />
          </button>
          {showAddMenu && (
            <div className="absolute top-full right-0 mt-1 bg-white dark:bg-[#121214] border border-gray-200 dark:border-white/10 rounded-lg shadow-xl py-1 z-50 w-36">
              <button
                onClick={() => { onAddNode('waypoint'); setShowAddMenu(false); }}
                className="w-full px-3 py-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-white/10 text-gray-900 dark:text-white transition-colors flex items-center gap-2"
              >
                <CircleDot size={12} className="text-blue-600 dark:text-blue-400" /> Waypoint
              </button>
              <button
                onClick={() => { onAddNode('conveyor'); setShowAddMenu(false); }}
                className="w-full px-3 py-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-white/10 text-gray-900 dark:text-white transition-colors flex items-center gap-2"
              >
                <ArrowUpFromLine size={12} className="text-amber-600" /> Conveyor
              </button>
              <button
                onClick={() => { onAddNode('shelf'); setShowAddMenu(false); }}
                className="w-full px-3 py-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-white/10 text-gray-900 dark:text-white transition-colors flex items-center gap-2"
              >
                <Box size={12} className="text-cyan-600" /> Shelf
              </button>
            </div>
          )}
        </div>

        <button
          onClick={onDeleteSelected}
          className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
          title="Delete Selected"
        >
          <Trash2 size={18} />
        </button>
      </div>

      {/* Sync Actions */}
      <div className="flex gap-1 pl-1">
        <button
          onClick={onReload}
          className="p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:bg-white/5 rounded-lg transition-all"
          title="Reload"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>

        <button
          onClick={onSave}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-lg hover:bg-slate-700 shadow-md transition-all active:translate-y-0.5 disabled:opacity-50"
        >
          <Save size={14} />
          <span>Save Complete</span>
        </button>
      </div>
    </div>
  );
};
