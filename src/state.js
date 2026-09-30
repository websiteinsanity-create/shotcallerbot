'use strict';

const fs   = require('fs/promises');
const path = require('path');
const log  = require('./logger');

const RUNTIME_PATH = path.join(__dirname, '..', 'data', 'runtime.json');

async function loadRuntime() {
  try {
    const raw = await fs.readFile(RUNTIME_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveRuntime(data) {
  try {
    await fs.mkdir(path.dirname(RUNTIME_PATH), { recursive: true });
    await fs.writeFile(RUNTIME_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    log.error('Failed to save runtime state:', err);
  }
}

module.exports = { loadRuntime, saveRuntime };
