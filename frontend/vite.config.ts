/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
// All env vars are read from the root .env (one directory up from frontend/)
// GATEWAY_URL — set in root .env to point at a remote robot
// e.g. GATEWAY_URL=http://10.61.6.87:8080

export default defineConfig(({ mode }) => {
  const rootDir = path.resolve(__dirname, '..')
  const env = loadEnv(mode, rootDir, '')
  const gatewayUrl = env.GATEWAY_URL ?? 'http://127.0.0.1:8080'

  return {
  plugins: [
    react(),
    tailwindcss()
  ],
  envDir: rootDir,
  server: {
    proxy: {
      '/api/vrp': {
        target: 'http://127.0.0.1:7779',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/vrp/, ''),
      },
      // Fallback for C++ server if needed
      '/api/cpp-vrp': {
        target: 'http://127.0.0.1:18080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/cpp-vrp/, ''),
      },
      '/api/fleet': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api\/fleet/, ''),
      },
      '/api/robot-gw': {
        target: gatewayUrl,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/robot-gw/, ''),
      },
    }
  },
  // vitest types are not automatically detected in some environments
  test: {
    environment: 'jsdom',
    globals: true,
  },
  }
})