import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};
http
  .createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const url = new URL(req.url, "http://project:8080");
      const target = path.resolve(
        "/site",
        "." + decodeURIComponent(url.pathname),
      );
      if (target !== "/site" && !target.startsWith("/site/")) {
        res.writeHead(400).end();
        return;
      }
      let file = target;
      if (url.pathname === "/") file = "/site/index.html";
      try {
        if (!(await fs.stat(file)).isFile()) throw 0;
      } catch {
        file = "/site/index.html";
      }
      const buf = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(req.method === "HEAD" ? undefined : buf);
    } catch {
      res.writeHead(500).end();
    }
  })
  .listen(8080, "0.0.0.0");
