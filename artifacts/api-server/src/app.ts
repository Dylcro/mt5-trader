import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import router from "./routes";
import adminRouter from "./routes/admin";
import authRouter from "./routes/auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/admin", adminRouter);
app.use("/api/auth", authRouter);

// Public privacy policy page — required by App Store and Google Play for financial apps
app.get("/privacy", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy – XAUUSD Trader</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.7; }
  h1 { color: #b8860b; } h2 { color: #333; margin-top: 2em; }
  a { color: #b8860b; }
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p><strong>XAUUSD Trader</strong> &mdash; Last updated: May 2026</p>

<h2>1. Information We Collect</h2>
<p>We collect the minimum information necessary to provide the service:</p>
<ul>
  <li><strong>Account credentials</strong>: Your MetaTrader 5 broker login and server details, transmitted over TLS and stored encrypted at rest. We never store your password in plaintext.</li>
  <li><strong>Authentication data</strong>: Email address and hashed password used to create your in-app account. We do not sell this data.</li>
  <li><strong>Trading activity</strong>: Trade commands and position data are relayed to your MetaTrader 5 broker via MetaAPI. We log requests for error-debugging purposes only.</li>
  <li><strong>Device/app data</strong>: App settings (cascade configuration) stored server-side and associated with your account.</li>
</ul>

<h2>2. How We Use Your Information</h2>
<p>We use the information collected solely to:</p>
<ul>
  <li>Connect to and operate your MetaTrader 5 trading account</li>
  <li>Authenticate you and keep your session secure</li>
  <li>Sync your trading settings across devices</li>
  <li>Debug service errors and improve reliability</li>
</ul>
<p>We do not use your data for advertising, analytics resale, or any purpose beyond operating this service.</p>

<h2>3. Data Sharing</h2>
<p>Your data is shared only with the following third-party services required to operate the app:</p>
<ul>
  <li><strong>MetaAPI</strong> (metaapi.cloud) &mdash; executes trades on your broker via the MetaTrader 5 protocol</li>
</ul>
<p>We do not sell, rent, or share your personal information with any other parties.</p>

<h2>4. Data Retention</h2>
<p>Your account data is retained for as long as your account is active. You may request deletion at any time by contacting us; we will remove your records within 30 days.</p>

<h2>5. Security</h2>
<p>All data in transit is protected by TLS. Passwords are hashed using bcrypt and never stored in plaintext. Broker credentials are encrypted at rest. We apply the principle of least privilege: each user can only access data tied to their own account.</p>

<h2>6. Your Rights</h2>
<p>Depending on your jurisdiction, you may have the right to access, correct, or delete your personal data. To exercise these rights, contact us at the address below.</p>

<h2>7. Children</h2>
<p>This app is intended for adults engaged in financial trading. We do not knowingly collect data from anyone under 18.</p>

<h2>8. Changes</h2>
<p>We may update this policy. Continued use of the app after changes constitutes acceptance of the updated policy.</p>

<h2>9. Contact</h2>
<p>Questions? Contact us at <a href="mailto:privacy@xauusdtrader.com">privacy@xauusdtrader.com</a>.</p>
</body>
</html>`);
});

app.use("/api", router);

// ── PWA web app — served after all API routes so /api/* is never shadowed ──
const webDist = path.join(__dirname, "../public");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((_req: Request, res: Response) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

export default app;
