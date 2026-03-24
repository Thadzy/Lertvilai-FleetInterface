import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useThemeStore } from '../store/themeStore';

const ThemeToggle: React.FC = () => {
  const { theme, toggleTheme } = useThemeStore();

  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 hover:ring-2 ring-blue-500/50 transition-all duration-300 group"
      aria-label="Toggle Theme"
    >
      {theme === 'dark' ? (
        <Sun size={20} className="group-hover:rotate-45 transition-transform duration-500" />
      ) : (
        <Moon size={20} className="group-hover:-rotate-12 transition-transform duration-500" />
      )}
    </button>
  );
};

export default ThemeToggle;
