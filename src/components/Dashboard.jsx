import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, API_URL } from '../lib/supabase.js';
import MachineSelector from './MachineSelector.jsx';

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function Dashboard({ session }) {
  const [machineConfig,    setMachineConfig]    = useState(null);
  const [existingMachines, setExistingMachines] = useState(null); // null = no selector, arr = show selector
  const [hostname,         setHostname]         = useState('');
  const [hookEnabled,      setHookEnabled]      = useState(false);
  const [hookLoading,      setHookLoading]      = useState(false);
  const [setupLoading,     setSetupLoading]     = useState(true);
  const [copied,           setCopied]           = useState(false);
  const [error,            setError]            = useState('');

  useEffect(() => {
    initMachine();
  }, []);

  async function initMachine() {
    setSetupLoading(true);
    try {
      // 1. Already configured — nothing to do
      const config = await window.relay.getMachineConfig();
      if (config?.machineId) {
        setMachineConfig(config);
        setHookEnabled(await window.relay.getHookStatus());
        setSetupLoading(false);
        return;
      }

      // 2. First run — check for existing machines on this account before creating a new one
      const { data: { session: s } } = await supabase.auth.getSession();
      const res = await fetch(`${API_URL}/machines/mine`, {
        headers: { Authorization: `Bearer ${s.access_token}` },
      });
      const machines = res.ok ? await res.json() : [];

      if (machines.length > 0) {
        const hn = await window.relay.getHostname();
        setHostname(hn);
        // Hostname match floats to top
        machines.sort((a, b) => {
          if (a.label === hn && b.label !== hn) return -1;
          if (b.label === hn && a.label !== hn) return  1;
          return 0;
        });
        setExistingMachines(machines);
        setSetupLoading(false);
        return;
      }

      // 3. No existing machines — register fresh
      await registerMachine(s);
    } catch (err) {
      setError(err.message);
    }
    setSetupLoading(false);
  }

  // ── Shared key generation + env write ─────────────────────────────────────────

  function makeRawKey() {
    return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  }

  async function writeMachineEnv({ machineId, machineLabel, rawKey }) {
    await window.relay.writeMachineConfig({
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      API_URL,
      MACHINE_ID:      machineId,
      MACHINE_LABEL:   machineLabel,
      MACHINE_API_KEY: rawKey,
      USER_ID:         session.user.id,
      TIMEOUT_SECONDS: '300',
      FAIL_OPEN:       'true',
      ALWAYS_ALLOW:    'node_modules,\\.git/,dist/,\\.next/',
      ALWAYS_BLOCK:    '',
    });
    const hookStatus = await window.relay.getHookStatus();
    setMachineConfig({ machineId, machineLabel, machineApiKey: rawKey, supabaseUrl: SUPABASE_URL });
    setHookEnabled(hookStatus);
    setExistingMachines(null);
  }

  // ── Registration (new machine) ────────────────────────────────────────────────

  async function registerMachine(sess) {
    const s            = sess ?? (await supabase.auth.getSession()).data.session;
    const machineId    = crypto.randomUUID();
    const rawKey       = makeRawKey();
    const apiKeyHash   = await sha256hex(rawKey);
    const machineLabel = await window.relay.getHostname();

    const res = await fetch(`${API_URL}/machines/register`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${s.access_token}`,
      },
      body: JSON.stringify({ machineId, machineLabel, apiKeyHash }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Registration failed (${res.status})`);
    }

    await writeMachineEnv({ machineId, machineLabel, rawKey });
  }

  // ── Reclaim (restore existing machine) ───────────────────────────────────────

  async function handleReclaim(machineId, machineLabel) {
    const rawKey       = makeRawKey();
    const apiKeyHash   = await sha256hex(rawKey);
    const currentLabel = machineLabel || await window.relay.getHostname();
    const { data: { session: s } } = await supabase.auth.getSession();

    const res = await fetch(`${API_URL}/machines/${machineId}/reclaim`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${s.access_token}`,
      },
      body: JSON.stringify({ apiKeyHash, machineLabel: currentLabel }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Reclaim failed (${res.status})`);
    }

    await writeMachineEnv({ machineId, machineLabel: currentLabel, rawKey });
  }

  // ── Delete ghost machine ──────────────────────────────────────────────────────

  async function handleDeleteMachine(machineId) {
    const { data: { session: s } } = await supabase.auth.getSession();
    const res = await fetch(`${API_URL}/machines/${machineId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${s.access_token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Delete failed (${res.status})`);
    }
  }

  // ── Register new from selector ────────────────────────────────────────────────

  async function handleRegisterNew() {
    const { data: { session: s } } = await supabase.auth.getSession();
    await registerMachine(s);
  }

  // ── Dashboard interactions ────────────────────────────────────────────────────

  async function toggleHook() {
    setHookLoading(true);
    try {
      await window.relay.setHookEnabled(!hookEnabled);
      setHookEnabled(!hookEnabled);
    } catch (err) {
      setError(err.message);
    }
    setHookLoading(false);
  }

  function copyMachineId() {
    if (!machineConfig?.machineId) return;
    navigator.clipboard.writeText(machineConfig.machineId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const qrData = machineConfig
    ? JSON.stringify({
        machineId:   machineConfig.machineId,
        apiKey:      machineConfig.machineApiKey,
        supabaseUrl: machineConfig.supabaseUrl || SUPABASE_URL,
        apiUrl:      API_URL,
      })
    : '';

  // ── Render ────────────────────────────────────────────────────────────────────

  if (setupLoading) {
    return (
      <div className="splash">
        <div className="spinner" />
        <p className="setup-label">Setting up…</p>
      </div>
    );
  }

  const header = (
    <header className="dash-header">
      <div className="header-logo">
        <span className="logo-icon">⬡</span>
        <span className="logo-text">Vibe Remote</span>
      </div>
      <div className="header-right">
        <span className="user-email">{session.user.email}</span>
        <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>Sign Out</button>
      </div>
    </header>
  );

  // First-run with existing machines — show selector instead of dashboard
  if (existingMachines) {
    return (
      <div className="dashboard">
        {header}
        <MachineSelector
          machines={existingMachines}
          hostname={hostname}
          onReclaim={handleReclaim}
          onNew={handleRegisterNew}
          onDelete={handleDeleteMachine}
        />
      </div>
    );
  }

  return (
    <div className="dashboard">
      {header}

      <main className="dash-main">
        {error && <div className="banner-error">{error}</div>}

        <section className="card">
          <h2 className="card-title">Machine ID</h2>
          <p className="card-sub">Unique identifier for this machine in the system.</p>
          <div className="id-row">
            <code className="machine-id">{machineConfig?.machineId || '—'}</code>
            <button className="btn-copy" onClick={copyMachineId}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {machineConfig?.machineLabel && (
            <p className="machine-label-text">Label: {machineConfig.machineLabel}</p>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">Mobile Connection</h2>
          <p className="card-sub">Scan this QR code with the Vibe Remote mobile app to connect your phone.</p>
          <div className="qr-wrap">
            {qrData ? (
              <div className="qr-box">
                <QRCodeSVG
                  value={qrData}
                  size={180}
                  bgColor="#ffffff"
                  fgColor="#0a0b10"
                  level="M"
                />
              </div>
            ) : (
              <div className="qr-placeholder">No config</div>
            )}
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">Claude Code Interception</h2>
          <p className="card-sub">
            When enabled, Claude Code tool calls (Bash, Write, Edit) are intercepted and sent to your mobile app for approval.
          </p>
          <div className="toggle-row">
            <div className="toggle-info">
              <span className={`status-dot ${hookEnabled ? 'on' : 'off'}`} />
              <span className="status-label">{hookEnabled ? 'Mobile Mode Active' : 'Interception Off'}</span>
            </div>
            <button
              className={`toggle-btn ${hookEnabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={toggleHook}
              disabled={hookLoading}
            >
              <span className="toggle-thumb" />
            </button>
          </div>
          {hookEnabled && (
            <p className="hook-hint">Claude Code actions are being routed to your mobile app.</p>
          )}
        </section>
      </main>
    </div>
  );
}
