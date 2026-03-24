import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---

/**
 * Access Environment Variables via Vite.
 * These are loaded from the .env.local file in the project root.
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// --- VALIDATION ---

/**
 * Fail-safe check to ensure the application does not start with broken config.
 * This prevents obscure "URL is undefined" errors deep in the React tree.
 */
if (!supabaseUrl || !supabaseAnonKey) {
  const errorMessage = 'CRITICAL ERROR: Missing Supabase environment variables. Please check your .env.local file.';
  console.error(errorMessage);
  throw new Error(errorMessage);
}

// --- CLIENT INITIALIZATION ---

/**
 * Global Supabase Client Instance.
 * * This acts as a Singleton for the entire application.
 * * Import this variable whenever you need to perform DB operations.
 * * Usage:
 * import { supabase } from '../lib/supabaseClient';
 * const { data } = await supabase.from('table').select('*');
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);