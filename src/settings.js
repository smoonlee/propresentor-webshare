const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  port: 4983,
  bindAddress: '0.0.0.0',
  captureFps: 30,
  jpegQuality: 70,
  startupUrl: '',
  alwaysOnTop: false,
  showDiagnostics: false,
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(settings) {
  // Merge with defaults so missing keys get filled
  cache = { ...DEFAULTS, ...settings };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Settings] Failed to save:', err.message);
  }
  return cache;
}

function get(key) {
  return load()[key];
}

function getAll() {
  return { ...load() };
}

function getDefaults() {
  return { ...DEFAULTS };
}

module.exports = { load, save, get, getAll, getDefaults };
