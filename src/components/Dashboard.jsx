import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, API_URL } from '../lib/supabase.js';

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function Dashboard({ session }) {
  const [machineConfig, setMachineConfig] = useState(null);
  const [hookEnabled, setHookEnabled] = useState(false);
  const [hookLoading, setHookLoading] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    initMachine();
  }, []);

  async function initMachine() {
    setSetupLoading(true);
    try {
      const config = await window.relay.getMachineConfig();

      if (config && config.machineId) {
        setMachineConfig(config);
      } else {
        await registerMachine();
      }

      const status = await window.relay.getHookStatus();
      setHookEnabled(status);
    } catch (err) {
      setError(err.message);
    }
    setSetupLoading(false);
  }

  async function registerMachine() {
    const machineId    = crypto.randomUUID();
    const rawKey       = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const apiKeyHash   = await sha256hex(rawKey);
    const machineLabel = await window.relay.getHostname();

    // Get current session JWT to authenticate the registration request to the VPS
    const { data: { session: currentSession } } = await supabase.auth.getSession();

    const res = await fetch(`${API_URL}/machines/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentSession.access_token}`,
      },
      body: JSON.stringify({ machineId, machineLabel, apiKeyHash }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Registration failed (${res.status})`);
    }

    // Write config to relay-deamon1/.env — no service key, never was
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

    setMachineConfig({ machineId, machineLabel, machineApiKey: rawKey, supabaseUrl: SUPABASE_URL });
  }

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

  async function signOut() {
    await supabase.auth.signOut();
  }

  const qrData = machineConfig
    ? JSON.stringify({
        machineId:   machineConfig.machineId,
        apiKey:      machineConfig.machineApiKey,
        supabaseUrl: machineConfig.supabaseUrl || SUPABASE_URL,
        apiUrl:      API_URL,
      })
    : '';

  if (setupLoading) {
    return (
      <div className="splash">
        <div className="spinner" />
        <p className="setup-label">Setting up machine…</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="header-logo">
          <span className="logo-icon">⬡</span>
          <span className="logo-text">Vibe Remote</span>
        </div>
        <div className="header-right">
          <span className="user-email">{session.user.email}</span>
          <button className="btn-ghost" onClick={signOut}>Sign Out</button>
        </div>
      </header>

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
