const mqtt = require('mqtt');
const ftp = require('basic-ftp');
const AdmZip = require('adm-zip');
const { PassThrough } = require('stream');

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
let cumulativeRaw = {};
let previousState = null;
let currentPrintUsage = null;
let currentPrintUsagePromise = null;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
  const output = isPlainObject(target) ? { ...target } : {};
  if (!isPlainObject(source)) return output;

  for (const [key, value] of Object.entries(source)) {
    if (key === 'ams') {
      output[key] = value;
      continue;
    }
    if (isPlainObject(value)) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }

  return output;
}

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
  const amsData = print?.ams;
  const trays = Array.isArray(amsData?.ams?.[0]?.tray) ? amsData.ams[0].tray : [];

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
    currentFile: String(print?.gcode_file || print?.subtask_name || ''),
    currentLayer: Math.round(n(print?.layer_num)),
    totalLayers: Math.round(n(print?.total_layer_num)),
    fanSpeed: Math.round(n(print?.cooling_fan_speed)),
    errors,
    ams: {
      humidity: n(amsData?.humidity),
      currentTray: n(amsData?.tray_now, -1),
      trays: trays.map((tray, index) => {
        const rawColor = String(tray?.tray_color || '').trim();
        return {
          slot: n(tray?.id, index),
          material: String(tray?.tray_type || '').trim(),
          color: rawColor.length > 6 ? rawColor.slice(0, -2) : rawColor,
          brand: String(tray?.tray_sub_brands || '').trim(),
          name: String(tray?.tray_id_name || '').trim(),
          remain: n(tray?.remain, -1),
          tempMin: n(tray?.nozzle_temp_min),
          tempMax: n(tray?.nozzle_temp_max),
        };
      }),
    },
  };
}

function normalizeRemotePathCandidates(rawPath) {
  const input = String(rawPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!input) return [];

  const out = new Set();
  const basename = input.split('/').filter(Boolean).pop() || input;
  const add = (value) => {
    const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
    if (normalized) out.add(normalized);
  };

  add(input);
  add(`/${input}`);
  if (!input.startsWith('cache/')) {
    add(`cache/${input}`);
    add(`/cache/${input}`);
  }
  add(`cache/${basename}`);
  add(`/cache/${basename}`);
  add(basename);
  add(`/${basename}`);

  return [...out];
}

async function downloadPrinterFile(filePath) {
  const candidates = normalizeRemotePathCandidates(filePath);
  if (!candidates.length) {
    throw new Error('No gcode file path available from printer status');
  }

  const client = new ftp.Client(10000);
  client.ftp.verbose = false;

  try {
    await client.access({
      host: printerIp,
      port: 990,
      user: 'bblp',
      password: accessCode,
      secure: 'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    for (const candidate of candidates) {
      const sink = new PassThrough();
      const chunks = [];
      sink.on('data', (chunk) => chunks.push(chunk));
      try {
        await client.downloadTo(sink, candidate);
        const fileBuffer = Buffer.concat(chunks);
        if (fileBuffer.length > 0) {
          return { fileBuffer, remotePath: candidate };
        }
      } catch {
        // Try the next path candidate.
      }
    }
  } finally {
    client.close();
  }

  throw new Error(`Could not download print file from FTP. Tried: ${candidates.join(', ')}`);
}

function extractGcodeTextFrom3mf(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const gcodeEntry = entries.find((entry) => !entry.isDirectory && /\.gcode$/i.test(entry.entryName));
  if (!gcodeEntry) throw new Error('No .gcode file found inside 3MF archive');
  return gcodeEntry.getData().toString('utf8');
}

function parseDirectFilamentGrams(gcodeText) {
  const lines = gcodeText.split(/\r?\n/);
  const directPatterns = [
    /;\s*total filament weight\s*\[g\]/i,
    /;\s*filament used\s*\[g\]/i,
    /;\s*total filament used/i,
  ];

  for (const line of lines) {
    if (!directPatterns.some((p) => p.test(line))) continue;
    const [, rhs = ''] = line.split('=');
    const source = rhs || line;
    const values = source.match(/[0-9]*\.?[0-9]+/g);
    if (!values || values.length === 0) continue;
    const sum = values.reduce((acc, value) => acc + (Number(value) || 0), 0);
    if (sum > 0) return sum;
  }

  return null;
}

function parseFilamentFromEValues(gcodeText) {
  const densityMatch = gcodeText.match(/;\s*filament_density\s*:\s*([0-9]*\.?[0-9]+)/i);
  const diameterMatch = gcodeText.match(/;\s*filament_diameter\s*:\s*([0-9]*\.?[0-9]+)/i);
  const density = Number(densityMatch?.[1] || 1.24);
  const diameter = Number(diameterMatch?.[1] || 1.75);
  if (!(density > 0) || !(diameter > 0)) return null;

  let absoluteMode = true;
  let currentE = 0;
  let totalExtrusionMm = 0;
  const lines = gcodeText.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.split(';', 1)[0].trim();
    if (!line) continue;

    if (/^M82\b/i.test(line)) {
      absoluteMode = true;
      continue;
    }
    if (/^M83\b/i.test(line)) {
      absoluteMode = false;
      continue;
    }
    if (/^G92\b/i.test(line)) {
      const resetMatch = line.match(/\bE(-?[0-9]*\.?[0-9]+)/i);
      if (resetMatch) currentE = Number(resetMatch[1]) || 0;
      continue;
    }

    if (!/^G0?1\b/i.test(line)) continue;
    const eMatch = line.match(/\bE(-?[0-9]*\.?[0-9]+)/i);
    if (!eMatch) continue;
    const eValue = Number(eMatch[1]);
    if (!Number.isFinite(eValue)) continue;

    if (absoluteMode) {
      const delta = eValue - currentE;
      if (delta > 0) totalExtrusionMm += delta;
      currentE = eValue;
    } else if (eValue > 0) {
      totalExtrusionMm += eValue;
    }
  }

  if (totalExtrusionMm <= 0) return null;
  const radius = diameter / 2;
  const crossSectionMm2 = Math.PI * radius * radius;
  const volumeMm3 = totalExtrusionMm * crossSectionMm2;
  const grams = (volumeMm3 / 1000) * density;
  return grams > 0 ? grams : null;
}

async function estimateFilamentUsedGrams(currentFilePath) {
  const { fileBuffer, remotePath } = await downloadPrinterFile(currentFilePath);
  const is3mf = /\.3mf$/i.test(remotePath) || /\.3mf$/i.test(String(currentFilePath || ''));
  const gcodeText = is3mf ? extractGcodeTextFrom3mf(fileBuffer) : fileBuffer.toString('utf8');

  const direct = parseDirectFilamentGrams(gcodeText);
  if (direct && Number.isFinite(direct) && direct > 0) {
    return {
      grams: Number(direct.toFixed(2)),
      source: 'comment',
      remotePath,
    };
  }

  const computed = parseFilamentFromEValues(gcodeText);
  if (computed && Number.isFinite(computed) && computed > 0) {
    return {
      grams: Number(computed.toFixed(2)),
      source: 'e-values',
      remotePath,
    };
  }

  return {
    grams: 0,
    source: 'unavailable',
    remotePath,
  };
}

function startFilamentEstimateForCurrentPrint(currentFilePath) {
  const normalizedFile = String(currentFilePath || '').trim();
  currentPrintUsage = {
    fileName: normalizedFile,
    grams: 0,
    source: 'pending',
    remotePath: '',
    calculatedAt: '',
  };

  currentPrintUsagePromise = estimateFilamentUsedGrams(normalizedFile)
    .then((result) => {
      currentPrintUsage = {
        fileName: normalizedFile,
        grams: Number(result.grams || 0),
        source: result.source || 'unknown',
        remotePath: result.remotePath || '',
        calculatedAt: new Date().toISOString(),
      };
      console.log('[bridge] filament estimate ready', `${currentPrintUsage.grams}g`, `source=${currentPrintUsage.source}`);
    })
    .catch((err) => {
      currentPrintUsage = {
        fileName: normalizedFile,
        grams: 0,
        source: 'error',
        remotePath: '',
        calculatedAt: new Date().toISOString(),
      };
      console.error('[bridge] filament estimate failed:', err.message);
    })
    .finally(() => {
      currentPrintUsagePromise = null;
    });
}

async function resolveFilamentForCompletion(fileNameHint) {
  if (currentPrintUsagePromise) {
    try {
      await currentPrintUsagePromise;
    } catch {
      // Error already logged by estimator.
    }
  }

  const hint = String(fileNameHint || '').trim();
  if (currentPrintUsage && currentPrintUsage.grams > 0) {
    if (!hint || !currentPrintUsage.fileName || currentPrintUsage.fileName === hint) {
      return Number(currentPrintUsage.grams.toFixed(2));
    }
  }

  if (!hint) return 0;

  try {
    const fallback = await estimateFilamentUsedGrams(hint);
    return Number((fallback.grams || 0).toFixed(2));
  } catch (err) {
    console.error('[bridge] fallback filament estimate failed:', err.message);
    return 0;
  }
}

async function requestJson(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${txt}`.trim());
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

async function putJson(url, body) {
  return requestJson(url, 'PUT', body);
}

async function postJson(url, body) {
  return requestJson(url, 'POST', body);
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
      const data = JSON.parse(messageBuffer.toString('utf8'));
      latestRaw = data;

      if (data && isPlainObject(data.print)) {
        cumulativeRaw = deepMerge(cumulativeRaw, data.print);
        latestParsed = parsePrinterStatus({ print: cumulativeRaw });

        if (previousState !== 'printing' && latestParsed.state === 'printing') {
          const startFile = String(latestParsed.currentFile || '').trim();
          if (startFile) {
            console.log('[bridge] print started, estimating filament usage for', startFile);
            startFilamentEstimateForCurrentPrint(startFile);
          } else {
            currentPrintUsage = null;
            currentPrintUsagePromise = null;
          }
        }

        if (previousState === 'printing' && latestParsed.state !== 'printing') {
          const payloadFileName = String(latestParsed.currentFile || currentPrintUsage?.fileName || '').trim();

          resolveFilamentForCompletion(payloadFileName)
            .then((filamentUsedGrams) => {
              const payload = {
                fileName: payloadFileName,
                activeTray: Number(latestParsed.ams?.currentTray ?? -1),
                filamentUsedGrams: Number((filamentUsedGrams || 0).toFixed(2)),
                completedAt: new Date().toISOString(),
              };

              return postJson(`${API_ENDPOINT}/api/print-completed`, payload).then(() => payload);
            })
            .then((payload) => {
              console.log(
                '[bridge] print completion recorded',
                payload.fileName || '(unknown file)',
                `filament=${payload.filamentUsedGrams}g`
              );
            })
            .catch((err) => {
              console.error('[bridge] failed to record print completion:', err.message);
            })
            .finally(() => {
              currentPrintUsage = null;
              currentPrintUsagePromise = null;
            });
        }

        previousState = latestParsed.state;
      }
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
