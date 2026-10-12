import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build works under any sub-path (e.g. GitHub Pages /real-lidar-flyover/).
  base: './',
  worker: { format: 'es' },
  // laz-perf ships as CommonJS; pre-bundle it so the module worker can import it in dev.
  optimizeDeps: { include: ['laz-perf/lib/worker/laz-perf.js'] },
  // three.js alone is ~600 kB minified; one bundle is fine for this app.
  build: { chunkSizeWarningLimit: 800 },
});
