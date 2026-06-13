#!/usr/bin/env node
/**
 * harness-cli.js — the bridge the Electron main process spawns.
 *
 * Electron's main.js is bundled by Vite and lives inside the asar; relay-deamon1
 * is shipped as a separate resource with its own node_modules. Rather than bundle
 * the registry into the renderer build, main.js shells out to this CLI (same
 * pattern the app already uses for the heartbeat). All harness logic therefore
 * lives in ONE place: the daemon.
 *
 * Usage (always prints a single JSON line to stdout):
 *   node harness-cli.js list
 *   node harness-cli.js enable  <harnessId>
 *   node harness-cli.js disable <harnessId>
 *   node harness-cli.js status  <harnessId>
 *   node harness-cli.js report          # push current inventory to the VPS
 *   node harness-cli.js apply-desired   # apply phone-requested toggles
 */
import { getAdapter, listInstalled } from './src/registry.js'
import { machineCtx, reportHarness, getDesired } from './src/harness-sdk/index.js'

function out(obj) { process.stdout.write(JSON.stringify(obj)) }
function fail(msg) { out({ ok: false, error: msg }); process.exit(1) }

async function pushReport() {
  try { await reportHarness(await listInstalled()) } catch { /* offline / unregistered → ignore */ }
}

async function main() {
  const [, , cmd, id] = process.argv

  switch (cmd) {
    case 'list': {
      out({ ok: true, harnesses: await listInstalled() })
      return
    }

    case 'status': {
      const a = await getAdapter(id)
      if (!a) return fail(`unknown harness: ${id}`)
      out({ ok: true, status: await a.mobile.status() })
      return
    }

    case 'enable':
    case 'disable': {
      const a = await getAdapter(id)
      if (!a) return fail(`unknown harness: ${id}`)
      if (cmd === 'enable') await a.mobile.enable(machineCtx())
      else                  await a.mobile.disable()
      const status = await a.mobile.status()
      await pushReport()
      out({ ok: true, harness: id, mobile_enabled: !!status.enabled })
      return
    }

    case 'report': {
      await pushReport()
      out({ ok: true })
      return
    }

    case 'apply-desired': {
      const desired = await getDesired()
      const applied = []
      for (const d of desired) {
        const a = await getAdapter(d.harness)
        if (!a || d.desired_enabled == null) continue
        const cur = (await a.mobile.status()).enabled
        if (d.desired_enabled && !cur)      { await a.mobile.enable(machineCtx()); applied.push(d.harness) }
        else if (!d.desired_enabled && cur) { await a.mobile.disable();            applied.push(d.harness) }
      }
      if (applied.length) await pushReport()
      out({ ok: true, applied })
      return
    }

    default:
      return fail(`unknown command: ${cmd || '(none)'} — use list|enable|disable|status|report|apply-desired`)
  }
}

main().catch((err) => fail(err.message))
