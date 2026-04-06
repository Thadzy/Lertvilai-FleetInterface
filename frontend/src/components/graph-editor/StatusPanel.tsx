import React from 'react';
import { Layers, Plus, Trash2 } from 'lucide-react';
import { Level } from '../../hooks/useGraphData';

interface LevelSelectorProps {
  levels: Level[];
  selectedLevel: number | null;
  onLevelSelect: (id: number | null) => void;
  showManager: boolean;
  setShowManager: (show: boolean) => void;
  newLevelAlias: string;
  setNewLevelAlias: (val: string) => void;
  newLevelHeight: string;
  setNewLevelHeight: (val: string) => void;
  onCreateLevel: () => void;
  onDeleteLevel: (id: number) => void;
}

export const LevelSelector: React.FC<LevelSelectorProps> = ({
  levels, selectedLevel, onLevelSelect, showManager, setShowManager,
  newLevelAlias, setNewLevelAlias, newLevelHeight, setNewLevelHeight,
  onCreateLevel, onDeleteLevel
}) => {
  return (
    <div className="mt-2 bg-white/90 dark:bg-[#121214]/90 backdrop-blur border border-gray-200 dark:border-white/10 shadow-sm px-3 py-2 rounded-xl pointer-events-auto">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
          <Layers size={10} /> Level Filter
        </span>
        <button
          onClick={() => setShowManager(!showManager)}
          className="text-[10px] text-blue-600 hover:text-blue-800 font-bold"
        >
          {showManager ? 'Close' : 'Manage'}
        </button>
      </div>

      <div className="flex gap-1 flex-wrap">
        <button
          onClick={() => onLevelSelect(null)}
          className={`px-2.5 py-1 text-[10px] font-bold rounded-full transition-all ${selectedLevel === null
            ? 'bg-slate-800 text-white shadow-md'
            : 'bg-gray-100 dark:bg-white/5 text-slate-500 hover:bg-slate-200'
            }`}
        >
          ALL
        </button>
        {levels.map((level) => (
          <button
            key={level.id}
            onClick={() => onLevelSelect(level.id)}
            className={`px-2.5 py-1 text-[10px] font-bold rounded-full transition-all ${selectedLevel === level.id
              ? 'bg-purple-600 text-white shadow-md'
              : 'bg-purple-50 text-purple-600 hover:bg-purple-100'
              }`}
          >
            {level.alias}
          </button>
        ))}
      </div>

      {showManager && (
        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-white/10 flex flex-col gap-2">
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="L1"
              value={newLevelAlias}
              onChange={(e) => setNewLevelAlias(e.target.value)}
              className="flex-1 text-[10px] px-2 py-1 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-[#09090b] text-gray-900 dark:text-white"
            />
            <input
              type="number"
              placeholder="m"
              value={newLevelHeight}
              onChange={(e) => setNewLevelHeight(e.target.value)}
              className="w-12 text-[10px] px-2 py-1 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-[#09090b] text-gray-900 dark:text-white"
            />
            <button onClick={onCreateLevel} className="px-2 py-1 bg-purple-600 text-white rounded"><Plus size={10} /></button>
          </div>
          {levels.map(l => (
            <div key={l.id} className="flex justify-between items-center text-[10px]">
              <span className="font-mono font-bold text-blue-600">{l.alias}</span>
              <span className="text-gray-400">{l.height}m</span>
              <button onClick={() => onDeleteLevel(l.id)} className="text-red-400"><Trash2 size={10} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface StatusPanelProps {
  toolMode: string;
  nodeCount: number;
  edgeCount: number;
  selectedLevelAlias: string | null;
  isDirty: boolean;
}

export const StatusPanel: React.FC<StatusPanelProps> = ({
  toolMode, nodeCount, edgeCount, selectedLevelAlias, isDirty
}) => {
  return (
    <div className="bg-slate-800/90 backdrop-blur text-slate-300 text-[10px] font-mono px-4 py-1.5 rounded-full flex gap-4 shadow-lg border border-gray-300 dark:border-white/10 pointer-events-auto">
      <span>MODE: <span className="text-white font-bold">{toolMode.toUpperCase()}</span></span>
      <span className="text-blue-600 dark:text-blue-400">|</span>
      <span>NODES: {nodeCount}</span>
      <span className="text-blue-600 dark:text-blue-400">|</span>
      <span>EDGES: {edgeCount}</span>
      {selectedLevelAlias && (
        <>
          <span className="text-blue-600 dark:text-blue-400">|</span>
          <span>LEVEL: <span className="text-purple-400 font-bold">{selectedLevelAlias}</span></span>
        </>
      )}
      {isDirty && (
        <>
          <span className="text-blue-600 dark:text-blue-400">|</span>
          <span className="text-amber-400 animate-pulse font-bold">UNSAVED CHANGES</span>
        </>
      )}
    </div>
  );
};
