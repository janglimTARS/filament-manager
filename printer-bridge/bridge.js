const mqtt = require('mqtt');

const API_ENDPOINT = 'https://filament-manager.jackanglim3.workers.dev';
const POLL_INTERVAL_MS = 30000;
const CONFIG_POLL_MS = 10000;

let printerIp = '';
let accessCode = '';
let serialNumber = '';
let reportTopic = '';
let requestTopic = '';
const requestPayload = JSON.stringify({ pushing: { command: 'pushall' } });

async function fetchConfig() {
  const res = await fetch(`${API_ENDPOINT}/api/printer`);
  if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
  const data = await res.json();
  return { ip: data.ip || '', token: data.token || '', serial: data.serial || '' };
}

async function waitForConfig() {
  console.log('[bridge] waiting for printer config from API...');
  while (true) {
    try {
      const cfg = await fetchConfig();
      if (cfg.ip && cfg.token && cfg.serial) {
        printerIp = cfg.ip;
        accessCode = cfg.token;
        serialNumber = cfg.serial;
        reportTopic = `device/${serialNumber}/report`;
        requestTopic = `device/${serialNumber}/request`;
        console.log(`[bridge] config loaded: ip=${printerIp}, serial=${serialNumber}`);
        return;
      }
      console.log('[bridge] config incomplete, retrying in 10s...');
    } catch (err) {
      console.error('[bridge] config fetch error:', err.message, '- retrying in 10s...');
    }
    await new Promise(r => setTimeout(r, CONFIG_POLL_MS));
  }
}

let latestParsed = null;
let latestRaw = null;

function n(value, fallback = 0) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : fallback;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parsePrinterStatus(payload) {
  const print = payload && typeof payload === 'object' && payload.print && typeof payload.print === 'object'
    ? payload.print
    : null;
  const rawState = String(print?.gcode_state || '').toUpperCase();

  let state = print ? 'idle' : 'offline';
  if (rawState === 'RUNNING') state = 'printing';
  else if (rawState === 'PAUSE') state = 'paused';
  else if (rawState === 'FAILED') state = 'error';
  else if (rawState === 'IDLE' || rawState === 'FINISH' || rawState === 'STANDBY') state = 'idle';

  const errors = Array.isArray(print?.hms) ? print.hms : [];
  if (errors.length > 0) state = 'error';

  return {
    state,
    nozzleTemp: n(print?.nozzle_temper),
    nozzleTarget: n(print?.nozzle_target_temper),
    bedTemp: n(print?.bed_temper),
    bedTarget: n(print?.bed_target_temper),
    chamberTemp: n(print?.chamber_temper),
    progress: Math.round(n(print?.mc_percent)),
    remainingMinutes: Math.round(n(print?.mc_remaining_time)),
    currentFile: String(print?.subtask_name || print?.gcode_file || ''),
    currentLayer: Math.round(n(print?.layer_num)),
    totalLayers: Math.round(n(print?.total_layer_num)),
    fanSpeed: Math.round(n(print?.cooling_fan_speed)),
    errors,
  };
}

async function putJson(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${txt}`.trim());
  }
}

async function pushStatusToApi() {
  if (!latestParsed) return;

  const fullBody = {
    ...latestParsed,
    raw: latestRaw,
    serialNumber,
    updatedAt: new Date().toISOString(),
  };

  await putJson(`${API_ENDPOINT}/api/printer-status`, fullBody);
  console.log('[bridge] status pushed', new Date().toISOString(), latestParsed.state, `${latestParsed.progress}%`);
}

async function main() {
  await waitForConfig();

  const client = mqtt.connect(`mqtts://${printerIp}:8883`, {
    username: 'bblp',
    password: accessCode,
    rejectUnauthorized: false,
    reconnectPeriod: 3000,
    keepalive: 30,
    connectTimeout: 15000,
  });

  client.on('connect', () => {
    console.log('[bridge] connected to printer MQTT');
    client.subscribe(reportTopic, (err) => {
      if (err) {
        console.error('[bridge] subscribe failed:', err.message);
        return;
      }
      console.log('[bridge] subscribed to', reportTopic);
      client.publish(requestTopic, requestPayload);
      console.log('[bridge] requested initial pushall');
    });
  });

  client.on('message', (topic, messageBuffer) => {
    if (topic !== reportTopic) return;
    try {
      const raw = JSON.parse(messageBuffer.toString('utf8'));
      latestRaw = raw;
      latestParsed = parsePrinterStatus(raw);
    } catch (err) {
      console.error('[bridge] bad JSON payload:', err.message);
    }
  });

  client.on('error', (err) => {
    console.error('[bridge] mqtt error:', err.message);
  });

  client.on('reconnect', () => {
    console.log('[bridge] reconnecting...');
  });

  setInterval(async () => {
    try {
      client.publish(requestTopic, requestPayload);
      await pushStatusToApi();
    } catch (err) {
      console.error('[bridge] push failed:', err.message);
    }
  }, POLL_INTERVAL_MS);

  process.on('SIGINT', () => {
    console.log('[bridge] shutting down...');
    client.end(true, () => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[bridge] fatal:', err.message);
  process.exit(1);
});
