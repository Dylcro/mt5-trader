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
// We inject it into the HTML as window.__CLERK_KEY__ so the app reads the
// correct production key without touching the 3 MB JS bundle.
const RUNTIME_CLERK_KEY = process.env.CLERK_PUBLISHABLE_KEY || "";
const CLERK_INJECTION = RUNTIME_CLERK_KEY
  ? `<script>window.__CLERK_KEY__=${JSON.stringify(RUNTIME_CLERK_KEY)};</script>`
  : "";

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

  // For HTML pages: inject the runtime Clerk publishable key so the app uses
  // the correct production Clerk instance instead of the baked-in dev key.
  if (CLERK_INJECTION && ext === ".html") {
    let html = fs.readFileSync(resolved, "utf-8");
    html = html.includes("</head>")
      ? html.replace("</head>", `${CLERK_INJECTION}</head>`)
      : CLERK_INJECTION + html;
    res.writeHead(200, { "content-type": contentType });
    res.end(html);
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

  // Session reset — clears all localStorage (Clerk tokens etc.) and redirects to root.
  // Useful when a stored dev-environment session blocks sign-in on the live app.
  if (pathname === "/reset") {
    // Expire all cookies on the domain so Clerk session cookies are cleared too
    res.setHeader("Set-Cookie", [
      "__client_uat=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax",
      "__session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax",
      "__clerk_db_jwt=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax",
    ]);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signing out…</title><style>body{background:#0A0A0F;color:#F0EFE7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style></head><body><p>Clearing session…</p><script>try{localStorage.clear();sessionStorage.clear();}catch(e){}try{document.cookie.split(";").forEach(function(c){document.cookie=c.replace(/^ +/,"").replace(/=.*/,"=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/");});}catch(e){}setTimeout(function(){window.location.replace("/");},800);</script></body></html>`);
    return;
  }

  // Privacy policy — required by App Store and Google Play for financial apps.
  if (pathname === "/privacy") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — XAUUSD Trader</title><style>body{background:#0A0A0F;color:#F0EFE7;font-family:-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:40px 24px 80px;line-height:1.7}h1{color:#C9A84C;font-size:1.6rem;margin-bottom:4px}h2{color:#C9A84C;font-size:1.1rem;margin-top:2rem}p,li{color:#C0BFB7;font-size:0.95rem}a{color:#C9A84C}hr{border:none;border-top:1px solid #1E1E2E;margin:2rem 0}</style></head><body><h1>Privacy Policy</h1><p style="color:#6E6E8A;font-size:0.85rem">Last updated: May 2026</p><hr><h2>What we collect</h2><p>XAUUSD Trader collects only what is necessary to operate the service:</p><ul><li>Your email address and hashed password for authentication (managed by Clerk).</li><li>Your MetaTrader 5 account credentials (login, password, server), stored encrypted and used solely to connect to your broker via MetaAPI.</li><li>Basic usage logs (API request metadata) for debugging and security purposes. These logs do not contain trade content.</li></ul><h2>What we do NOT collect</h2><ul><li>We do not sell, share, or rent your personal data to any third party.</li><li>We do not use your data for advertising.</li><li>We do not store trade history or financial data beyond what MetaTrader 5 and MetaAPI retain on their own infrastructure.</li></ul><h2>Third-party services</h2><p>The app uses the following third-party services, each with their own privacy policy:</p><ul><li><a href="https://clerk.com/privacy" target="_blank">Clerk</a> — authentication</li><li><a href="https://metaapi.cloud/privacy-policy" target="_blank">MetaAPI</a> — MetaTrader 5 connectivity</li></ul><h2>Data retention</h2><p>You may delete your account at any time by contacting support. Upon deletion, all stored credentials and account data are removed within 30 days.</p><h2>Contact</h2><p>For privacy questions, contact us at the support address listed in the App Store listing.</p></body></html>`);
    return;
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
