const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const {
  printerIp,
  accessCode,
  serialNumber,
  apiEndpoint = 'https://filament-manager.jackanglim3.workers.dev',
  pollIntervalMs = 30000,
} = config;

if (!printerIp || !accessCode || !serialNumber || [printerIp, accessCode, serialNumber].some((v) => String(v).includes('_HERE'))) {
  console.error('[bridge] config.json is not configured. Please set printerIp, accessCode, and serialNumber.');
  process.exit(1);
}

const reportTopic = `device/${serialNumber}/report`;
const requestTopic = `device/${serialNumber}/request`;
const requestPayload = JSON.stringify({ pushing: { command: 'pushall' } });

let latestParsed = null;
let latestRaw = null;

function n(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parsePrinterStatus(payload) {
  const print = payload?.print || payload || {};
  const rawState = String(print.gcode_state || '').toUpperCase();

  let state = 'offline';
  if (rawState === 'RUNNING') state = 'printing';
  else if (rawState === 'PAUSE') state = 'paused';
  else if (rawState === 'FAILED') state = 'error';
  else if (rawState === 'IDLE' || rawState === 'FINISH') state = 'idle';

  const errors = Array.isArray(print.hms) ? print.hms : [];
  if (errors.length > 0) state = 'error';

  return {
    state,
    nozzleTemp: n(print.nozzle_temper),
    nozzleTarget: n(print.nozzle_target_temper),
    bedTemp: n(print.bed_temper),
    bedTarget: n(print.bed_target_temper),
    chamberTemp: n(print.chamber_temper),
    progress: Math.round(n(print.mc_percent)),
    remainingMinutes: Math.round(n(print.mc_remaining_time)),
    currentFile: String(print.gcode_file || ''),
    currentLayer: Math.round(n(print.layer_num)),
    totalLayers: Math.round(n(print.total_layer_num)),
    fanSpeed: Math.round(n(print.cooling_fan_speed)),
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

  const printerConfigBody = {
    ip: printerIp,
    token: accessCode,
  };

  const fullBody = {
    ...latestParsed,
    raw: latestRaw,
    serialNumber,
    updatedAt: new Date().toISOString(),
  };

  await Promise.all([
    putJson(`${apiEndpoint}/api/printer`, printerConfigBody),
    putJson(`${apiEndpoint}/api/printer-status`, fullBody),
  ]);

  console.log('[bridge] status pushed', new Date().toISOString(), latestParsed.state, `${latestParsed.progress}%`);
}

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
}, Math.max(5000, Number(pollIntervalMs) || 30000));

process.on('SIGINT', () => {
  console.log('[bridge] shutting down...');
  client.end(true, () => process.exit(0));
});
