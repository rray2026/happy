import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Inject build-time metadata so the settings page can show "you're running
// this build". Helps diagnose "I deployed but don't see the new field" —
// if the timestamp doesn't match what was pushed, the user's browser is
// still on a stale bundle (service worker / cache / wrong host).
const BUILD_TIME = new Date().toISOString()
const BUILD_COMMIT = (() => {
    try {
        return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    } catch {
        return 'unknown'
    }
})()

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
  },
  server: {
    port: 5173,
  },
})
