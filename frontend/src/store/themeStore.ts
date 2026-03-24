import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark', // Default to dark as per current design
      setTheme: (theme) => {
        set({ theme });
        updateDocument(theme);
      },
      toggleTheme: () => {
        set((state) => {
          const newTheme = state.theme === 'dark' ? 'light' : 'dark';
          updateDocument(newTheme);
          return { theme: newTheme };
        });
      },
    }),
    {
      name: 'theme-storage',
    }
  )
);

function updateDocument(theme: Theme) {
  if (typeof document !== 'undefined') {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }
}

// Initial sync
if (typeof document !== 'undefined') {
  const stored = localStorage.getItem('theme-storage');
  const theme = stored ? JSON.parse(stored).state.theme : 'dark';
  updateDocument(theme);
}
