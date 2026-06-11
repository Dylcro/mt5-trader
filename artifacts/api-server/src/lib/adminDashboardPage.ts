import { ADMIN_PAGE_CSS, APP_THEME } from "./appTheme";
import type { PlatformFlags } from "./platformFlags";

export type AdminDashboardData = {
  key: string;
  hideTest: boolean;
  flags: PlatformFlags;
  stats: {
    realUsers: number;
    linked: number;
    liveStreams: number;
    signupsToday: number;
    signupsWeek: number;
    openZones: number;
    unreadSupport: number;
    waitlistCount: number;
    smokeHidden: number;
  };
  health: {
    backend: boolean;
    database: boolean;
    ea_terminal: boolean;
    streamsHealthy: boolean;
    liveStreamCount: number;
  };
  clientRowsHtml: string;
  supportRowsHtml: string;
  waitlistRowsHtml: string;
  smokePurgeCount: number;
  testToggleHref: string;
  testToggleLabel: string;
  publicAppUrl: string;
};

export function renderAdminDashboard(d: AdminDashboardData): string {
  const tradingOn = !d.flags.tradingPaused;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>XAUUSD Trader — Admin</title>
<style>${ADMIN_PAGE_CSS}
  .layout { display: grid; gap: 24px; }
  .controls-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
  .kill-card { border-color: rgba(224,52,80,0.35); }
  .kill-card.active { background: ${APP_THEME.dangerLight}; }
  .health-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .health-pill { padding: 8px 14px; border-radius: 20px; font-size: 11px; font-weight: 700; border: 1px solid ${APP_THEME.border}; background: ${APP_THEME.card}; }
  .health-pill.ok { background: rgba(11,173,107,0.1); color: ${APP_THEME.success}; border-color: rgba(11,173,107,0.25); }
  .health-pill.bad { background: ${APP_THEME.dangerLight}; color: ${APP_THEME.danger}; }
  .modal { display: none; position: fixed; inset: 0; background: rgba(13,20,33,0.45); z-index: 100; align-items: center; justify-content: center; padding: 20px; }
  .modal.open { display: flex; }
  .modal-box { background: ${APP_THEME.card}; border-radius: 16px; padding: 22px; max-width: 420px; width: 100%; border: 1px solid ${APP_THEME.border}; box-shadow: 0 8px 32px ${APP_THEME.shadow}; }
  .modal-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  .field-label { font-size: 11px; color: ${APP_THEME.textMuted}; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
  .field { margin-bottom: 12px; }
  .row-actions button { margin-right: 6px; margin-bottom: 4px; }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <span class="symbol">XAUUSD</span>
      <span class="brand-sub">Admin panel</span>
    </div>
    <span class="topbar-time">${new Date().toUTCString()}</span>
  </div>
</header>
<div class="page layout">
  <section class="section" id="overview">
    <h2>Overview <span class="badge">real users only</span></h2>
    <div class="stats">
      <div class="stat"><div class="stat-n">${d.stats.realUsers}</div><div class="stat-l">Real users</div></div>
      <div class="stat"><div class="stat-n">${d.stats.linked}</div><div class="stat-l">MT5 linked</div></div>
      <div class="stat"><div class="stat-n ${d.health.streamsHealthy ? "success" : "warn"}">${d.stats.liveStreams}</div><div class="stat-l">Live streams</div></div>
      <div class="stat"><div class="stat-n">${d.stats.signupsToday}</div><div class="stat-l">Signups today</div></div>
      <div class="stat"><div class="stat-n">${d.stats.signupsWeek}</div><div class="stat-l">Signups (7d)</div></div>
      <div class="stat"><div class="stat-n">${d.stats.openZones}</div><div class="stat-l">Open zones</div></div>
    </div>
  </section>

  <section class="section" id="status">
    <h2>System status</h2>
    <div class="card">
      <div class="health-row" id="healthPills">
        <span class="health-pill ok">Backend up</span>
        <span class="health-pill ${d.health.database ? "ok" : "bad"}">Database ${d.health.database ? "connected" : "down"}</span>
        <span class="health-pill ${d.health.ea_terminal ? "ok" : "bad"}">EA Terminal ${d.health.ea_terminal ? "configured" : "not configured"}</span>
        <span class="health-pill ${d.health.streamsHealthy ? "ok" : "warn"}">Streams ${d.health.liveStreamCount} live</span>
      </div>
    </div>
  </section>

  <section class="section" id="controls">
    <h2>Controls</h2>
    <div class="controls-grid">
      <div class="card kill-card ${tradingOn ? "" : "active"}">
        <h2 style="margin-bottom:8px;color:${tradingOn ? APP_THEME.text : APP_THEME.danger}">Kill switch</h2>
        <p class="section-hint">Pauses <strong>new trades</strong> for all users instantly. Existing positions untouched.</p>
        <p class="muted" style="font-size:12px;margin-bottom:10px">Now: <strong>${tradingOn ? "Trading ON" : "Trading PAUSED"}</strong></p>
        <button type="button" class="btn-danger btn" id="toggleTradingBtn">${tradingOn ? "Pause trading (all users)" : "Resume trading"}</button>
        <div class="field" style="margin-top:12px">
          <div class="field-label">Pause message</div>
          <input class="input" id="pauseMessage" value="${escapeAttr(d.flags.tradingPauseMessage)}">
        </div>
      </div>
      <div class="card">
        <h2 style="margin-bottom:8px">Membership</h2>
        <div class="field"><div class="field-label">Cap (max real users)</div>
          <input class="input" type="number" id="membershipCap" min="1" value="${d.flags.membershipCap}"></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px">
          <input type="checkbox" id="inviteOnly" ${d.flags.inviteOnly ? "checked" : ""}> Invite-only signups
        </label>
        <div class="field"><div class="field-label">Invite code</div>
          <input class="input" id="inviteCode" value="${escapeAttr(d.flags.inviteCode ?? "")}" placeholder="e.g. DEMO2026"></div>
        <div class="field" style="margin-top:10px"><div class="field-label">Invite link (send to testers)</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input class="input" id="inviteLink" readonly style="flex:1;min-width:200px" value="${escapeAttr(inviteLinkFor(d.publicAppUrl, d.flags.inviteCode))}">
            <button type="button" class="btn" id="copyInviteLinkBtn">Copy link</button>
          </div>
        </div>
        <p class="section-hint" id="inviteShareHint" style="margin-top:8px;font-size:12px">Testers open the link on their phone (or paste the code in the app under <strong>Create account → Invite code</strong>). Save membership after changing the code.</p>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px">
          <input type="checkbox" id="signupsOpen" ${d.flags.signupsOpen ? "checked" : ""}> Signups open
        </label>
        <button type="button" class="btn-primary" id="saveMembershipBtn">Save membership settings</button>
      </div>
      <div class="card">
        <h2 style="margin-bottom:8px">Waitlist <span class="badge">${d.stats.waitlistCount}</span></h2>
        <table><thead><tr><th>Email</th><th>When</th></tr></thead>
        <tbody>${d.waitlistRowsHtml || '<tr><td colspan="2" class="empty">Empty</td></tr>'}</tbody></table>
      </div>
    </div>
  </section>

  <section class="section" id="users">
    <h2>Clients <span class="badge">${d.stats.realUsers}</span></h2>
    <p class="section-hint">Click <strong>Manage</strong> for lock, delete, disconnect MT5, reset password. Smoke-test users hidden by default.</p>
    <div class="toolbar">
      <input type="search" id="clientSearch" class="search" placeholder="Search name, email, MT5…">
      <a class="btn" href="${d.testToggleHref}">${d.testToggleLabel}</a>
      ${d.smokePurgeCount > 0 ? `<button type="button" class="btn btn-danger" id="purgeSmokeBtn">Delete ${d.smokePurgeCount} smoke users</button>` : ""}
      <button type="button" class="btn" id="clearLockoutsBtn">Clear all login lockouts</button>
    </div>
    <table id="clientsTable"><thead><tr>
      <th>Client</th><th>Email</th><th>MT5 #</th><th>Server</th><th>Stream</th><th>Status</th><th></th>
    </tr></thead><tbody>${d.clientRowsHtml}</tbody></table>
  </section>

  <section class="section" id="support">
    <h2>Support <span class="badge">${d.stats.unreadSupport} unread</span></h2>
    <table><thead><tr><th>Name</th><th>Email</th><th>Message</th><th>When</th><th></th></tr></thead>
    <tbody>${d.supportRowsHtml}</tbody></table>
  </section>

  <section class="section" id="tools">
    <h2>Tools</h2>
    <div class="card">
      <h2 style="margin-bottom:10px">Migrate MT5 region</h2>
      <form id="migrateForm" style="display:grid;gap:8px;max-width:400px">
        <input class="input" name="login" placeholder="MT5 login" required>
        <input class="input" name="password" type="password" placeholder="MT5 password" required>
        <input class="input" name="server" placeholder="MT5 server" required>
        <input class="input" name="targetRegion" value="new-york" placeholder="Target region">
        <button type="submit" class="btn-primary">Migrate account</button>
      </form>
      <pre id="migrateResult" class="code-block"></pre>
    </div>
  </section>
</div>

<div class="modal" id="userModal">
  <div class="modal-box">
    <h2 id="modalTitle" style="margin-bottom:8px">User</h2>
    <p id="modalSub" class="muted" style="font-size:12px;margin-bottom:12px"></p>
    <div class="modal-actions">
      <button type="button" class="btn" id="modalLockBtn">Lock</button>
      <button type="button" class="btn" id="modalUnlockBtn">Unlock</button>
      <button type="button" class="reset-btn" id="modalResetPwBtn">Reset password</button>
      <button type="button" class="btn" id="modalDisconnectBtn">Force-disconnect MT5</button>
      <button type="button" class="btn-danger btn" id="modalDeleteBtn">Delete user</button>
      <button type="button" class="btn" id="modalCloseBtn">Close</button>
    </div>
    <pre id="modalDetail" class="code-block" style="display:block;max-height:200px;margin-top:12px"></pre>
  </div>
</div>

<script>
(function() {
  var key = ${JSON.stringify(d.key)};
  var modalUser = null;

  function api(path, opts) {
    opts = opts || {};
    var url = '/api/admin' + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(key);
    return fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  }

  var search = document.getElementById('clientSearch');
  var table = document.getElementById('clientsTable');
  if (search && table) {
    search.addEventListener('input', function() {
      var q = search.value.toLowerCase().trim();
      table.querySelectorAll('tbody tr').forEach(function(tr) {
        var hay = tr.getAttribute('data-search') || '';
        tr.style.display = !q || hay.indexOf(q) >= 0 ? '' : 'none';
      });
    });
  }

  document.querySelectorAll('.manage-user-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      modalUser = { id: btn.getAttribute('data-id'), email: btn.getAttribute('data-email'), name: btn.getAttribute('data-name'), locked: btn.getAttribute('data-locked') === '1' };
      document.getElementById('modalTitle').textContent = modalUser.name;
      document.getElementById('modalSub').textContent = modalUser.email + (modalUser.locked ? ' · LOCKED' : '');
      document.getElementById('userModal').classList.add('open');
      api('/users/' + modalUser.id + '/detail').then(function(r) { return r.json(); }).then(function(j) {
        document.getElementById('modalDetail').textContent = JSON.stringify(j, null, 2);
      });
    });
  });
  document.getElementById('modalCloseBtn').onclick = function() { document.getElementById('userModal').classList.remove('open'); };

  document.getElementById('modalLockBtn').onclick = function() {
    if (!modalUser || !confirm('Lock ' + modalUser.email + '?')) return;
    api('/users/' + modalUser.id + '/lock', { method: 'POST', body: JSON.stringify({ reason: 'Admin lock' }) }).then(function() { location.reload(); });
  };
  document.getElementById('modalUnlockBtn').onclick = function() {
    if (!modalUser || !confirm('Unlock ' + modalUser.email + '?')) return;
    api('/users/' + modalUser.id + '/unlock', { method: 'POST' }).then(function() { location.reload(); });
  };
  document.getElementById('modalDeleteBtn').onclick = function() {
    if (!modalUser || !confirm('DELETE user ' + modalUser.email + '? This cannot be undone.')) return;
    api('/users/' + modalUser.id, { method: 'DELETE' }).then(function() { location.reload(); });
  };
  document.getElementById('modalDisconnectBtn').onclick = function() {
    if (!modalUser || !confirm('Force-disconnect MT5 for ' + modalUser.email + '?')) return;
    api('/users/' + modalUser.id + '/disconnect-mt5', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(j) { alert(j.message || 'Done'); location.reload(); });
  };
  document.getElementById('modalResetPwBtn').onclick = function() {
    if (!modalUser) return;
    var pw = prompt('New password for ' + modalUser.email + ' (min 8 chars):');
    if (!pw || pw.length < 8) return;
    fetch('/api/admin/users/reset-password?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: modalUser.email, newPassword: pw }),
    }).then(function(r) { return r.json(); }).then(function(j) { alert(j.message || j.error); if (j.ok) location.reload(); });
  };

  document.getElementById('toggleTradingBtn').onclick = function() {
    var pause = ${JSON.stringify(tradingOn)};
    if (pause && !confirm('Pause trading for ALL users?')) return;
    if (!pause && !confirm('Resume trading for all users?')) return;
    api('/settings/trading', { method: 'POST', body: JSON.stringify({
      tradingPaused: pause,
      tradingPauseMessage: document.getElementById('pauseMessage').value,
    }) }).then(function() { location.reload(); });
  };

  function updateInviteLink() {
    var code = (document.getElementById('inviteCode').value || '').trim();
    var base = ${JSON.stringify(d.publicAppUrl)};
    var link = code ? (base + '/join?code=' + encodeURIComponent(code)) : (base + '/join');
    document.getElementById('inviteLink').value = link;
  }
  document.getElementById('inviteCode').addEventListener('input', updateInviteLink);
  document.getElementById('copyInviteLinkBtn').onclick = function() {
    var el = document.getElementById('inviteLink');
    el.select();
    el.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(el.value).then(function() { alert('Invite link copied'); }).catch(function() { alert(el.value); });
  };

  document.getElementById('saveMembershipBtn').onclick = function() {
    api('/settings/membership', { method: 'POST', body: JSON.stringify({
      membershipCap: Number(document.getElementById('membershipCap').value),
      inviteOnly: document.getElementById('inviteOnly').checked,
      inviteCode: document.getElementById('inviteCode').value || null,
      signupsOpen: document.getElementById('signupsOpen').checked,
    }) }).then(function(r) { return r.json(); }).then(function(j) { alert(j.ok ? 'Saved' : (j.error || 'Failed')); });
  };

  var purge = document.getElementById('purgeSmokeBtn');
  if (purge) purge.onclick = function() {
    if (!confirm('Delete all smoke-test users and their DB links?')) return;
    api('/purge-smoke-users', { method: 'POST' }).then(function() { location.reload(); });
  };

  document.getElementById('clearLockoutsBtn').onclick = function() {
    api('/reset-lockouts', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(j) { alert(j.message || j.error); });
  };

  document.querySelectorAll('.support-resolve').forEach(function(btn) {
    btn.addEventListener('click', function() {
      api('/support/' + btn.getAttribute('data-id') + '/resolve', { method: 'POST' }).then(function() { location.reload(); });
    });
  });
  document.querySelectorAll('.support-read').forEach(function(btn) {
    btn.addEventListener('click', function() {
      api('/support/' + btn.getAttribute('data-id') + '/read', { method: 'POST' }).then(function() { location.reload(); });
    });
  });

  var form = document.getElementById('migrateForm');
  var out = document.getElementById('migrateResult');
  if (form) form.addEventListener('submit', function(e) {
    e.preventDefault();
    var fd = new FormData(form);
    fetch('/api/mt5/admin/migrate-region', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(Object.fromEntries(fd.entries())),
    }).then(function(r) { return r.json(); }).then(function(j) { out.style.display = 'block'; out.textContent = JSON.stringify(j, null, 2); });
  });
})();
</script>
</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function inviteLinkFor(baseUrl: string, code: string | null): string {
  const base = baseUrl.replace(/\/$/, "");
  const c = (code ?? "").trim();
  return c ? `${base}/join?code=${encodeURIComponent(c)}` : `${base}/join`;
}
