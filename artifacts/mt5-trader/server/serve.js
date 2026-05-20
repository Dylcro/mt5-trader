/**
 * Production server for the MT5 Trader app.
 *
 * Request routing:
 *  - expo-platform: ios|android header → Expo Go manifest (for OTA updates)
 *  - Everything else → Expo web PWA build from dist/
 *    Falls back to the Expo Go landing page if dist/ hasn't been built yet.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const STATIC_ROOT  = path.resolve(__dirname, "..", "static-build");
const TEMPLATE_PATH = path.resolve(__dirname, "templates", "landing-page.html");
const WEB_DIST     = path.resolve(__dirname, "..", "dist");
const basePath     = (process.env.BASE_PATH || "/").replace(/\/+$/, "");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".otf":  "font/otf",
  ".map":  "application/json",
};

const hasWebBuild = fs.existsSync(path.join(WEB_DIST, "index.html"));
console.log(`Web PWA build: ${hasWebBuild ? WEB_DIST : "NOT FOUND — will show landing page"}`);

// At build time the Clerk publishable key is baked into the JS bundle as the
// dev key (pk_test_...). In production Replit injects the live key via env var.
// We swap the baked-in key at serve time so the PWA authenticates against the
// correct production user store. Cache the patched buffer to avoid re-reading
// the 3 MB bundle on every request.
const RUNTIME_CLERK_KEY = process.env.CLERK_PUBLISHABLE_KEY || "";
const bundleCache = new Map(); // resolved file path → patched Buffer/string

function getAppName() {
  try {
    const appJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "app.json"), "utf-8"));
    return appJson.expo?.name || "App";
  } catch { return "App"; }
}

function serveManifest(platform, res) {
  const manifestPath = path.join(STATIC_ROOT, platform, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Manifest not found for platform: ${platform}` }));
    return;
  }
  const manifest = fs.readFileSync(manifestPath, "utf-8");
  res.writeHead(200, {
    "content-type": "application/json",
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
  });
  res.end(manifest);
}

function serveLandingPage(req, res, template, appName) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers["host"];
  const baseUrl = `${proto}://${host}`;
  const html = template
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, host)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function serveWebFile(urlPath, res) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(WEB_DIST, safePath);

  if (!filePath.startsWith(WEB_DIST)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // Try exact file first, then index.html inside a directory, then SPA fallback
  let resolved = filePath;
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    resolved = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(resolved)) {
    resolved = path.join(WEB_DIST, "index.html");
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // JS bundles: swap the baked-in dev Clerk key with the runtime production key.
  // Result is cached in memory after the first request.
  if (RUNTIME_CLERK_KEY && ext === ".js") {
    if (!bundleCache.has(resolved)) {
      const text = fs.readFileSync(resolved, "utf-8");
      const patched = text.includes("pk_test_")
        ? text.replace(/pk_test_[A-Za-z0-9]+/g, RUNTIME_CLERK_KEY)
        : text;
      bundleCache.set(resolved, patched);
    }
    res.writeHead(200, { "content-type": contentType });
    res.end(bundleCache.get(resolved));
    return;
  }

  const content = fs.readFileSync(resolved);
  res.writeHead(200, { "content-type": contentType });
  res.end(content);
}

function serveStaticFile(urlPath, res) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(STATIC_ROOT, safePath);

  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": contentType });
  res.end(fs.readFileSync(filePath));
}

const landingPageTemplate = fs.readFileSync(TEMPLATE_PATH, "utf-8");
const appName = getAppName();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = url.pathname;

  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || "/";
  }

  // Expo Go manifest requests — always serve the native bundle manifest
  const platform = req.headers["expo-platform"];
  if ((pathname === "/" || pathname === "/manifest") && (platform === "ios" || platform === "android")) {
    return serveManifest(platform, res);
  }

  // Regular browser — serve the Expo web PWA
  if (hasWebBuild) {
    return serveWebFile(pathname, res);
  }

  // Fallback: no web build present, show Expo Go landing page
  if (pathname === "/") {
    return serveLandingPage(req, res, landingPageTemplate, appName);
  }

  serveStaticFile(pathname, res);
});

const port = parseInt(process.env.PORT || "3000", 10);
server.listen(port, "0.0.0.0", () => {
  console.log(`MT5 Trader server on port ${port} — mode: ${hasWebBuild ? "PWA" : "Expo Go landing"}`);
});
