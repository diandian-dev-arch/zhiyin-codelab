// 运行：在仓库根执行
//   node apps/web/node_modules/vite/bin/vite.js design-proposals/2026-10-18-glass-lab/handoff/assets/examples/harness
// 复用 apps/web 已安装的依赖；如果交付包被移出仓库，用环境变量 CODELAB_WEB 指向 apps/web 目录。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const web = process.env.CODELAB_WEB ?? resolve(here, "../../../../../../apps/web");
const require = createRequire(resolve(web, "package.json"));
const vue = (await import(pathToFileURL(require.resolve("@vitejs/plugin-vue")).href)).default;

export default {
  root: here,
  plugins: [vue()],
  resolve: { alias: { vue: require.resolve("vue/dist/vue.runtime.esm-bundler.js") } },
  server: { host: "127.0.0.1", port: Number(process.env.PORT) || 5189, fs: { allow: [resolve(here, "../.."), web] } },
};
