import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue(), {
    name: 'existing-workspace-entry',
    configureServer(server) {
      // A standalone preview must not strand users when the persistent workspace
      // is already running. Never rewrite Origin or bypass API authorization.
      server.middlewares.use(async (req, res, next) => {
        if (process.env.API_PROXY_TARGET || server.config.server.port !== 5173 ||
            req.method !== 'GET' || !req.headers.accept?.includes('text/html')) return next();
        const healthy = async (url: string) => {
          try { return (await fetch(url, {signal: AbortSignal.timeout(1000)})).ok; }
          catch { return false; }
        };
        if (await healthy('http://127.0.0.1:3100/api/v1/health')) return next();
        if (!await healthy('http://127.0.0.1:5174/api/v1/health')) return next();
        const target = new URL(req.url ?? '/', 'http://127.0.0.1:5173');
        res.writeHead(307, {Location: `http://127.0.0.1:5174${target.pathname}${target.search}`, 'Cache-Control':'no-store'});
        res.end();
      });
    },
  }],
  server: {
    port: Number(process.env.WEB_PORT ?? 5174),
    strictPort: false,
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3100" },
  },
});
