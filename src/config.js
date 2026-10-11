import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PORT = 4141;
export const BUNDLED_CATALOG = path.join(here, '..', 'providers.json');

export function homeDir() {
  return process.env.SEAMLESS_HOME || path.join(os.homedir(), '.seamless');
}

function configPath() {
  return path.join(homeDir(), 'config.json');
}

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { keys: {} };
    throw new Error(`Could not read ${configPath()}: ${err.message}`);
  }
}

/**
 * A function returning the current config, re-read only when the file
 * changes, for a server that keeps running while the user changes settings.
 * If the file is mid-write or broken, the last good config is kept.
 */
export function liveConfig() {
  let config = loadConfig();
  let stamp = configStamp();
  return () => {
    const now = configStamp();
    if (now !== stamp) {
      try {
        config = loadConfig();
        stamp = now;
      } catch {}
    }
    return config;
  };
}

function configStamp() {
  try {
    const { mtimeMs, size } = fs.statSync(configPath());
    return `${mtimeMs}:${size}`;
  } catch {
    return 'none';
  }
}

export function saveConfig(config) {
  // Keys live here, so keep the file private to the user.
  writePrivate(configPath(), config);
}

function probesPath() {
  return path.join(homeDir(), 'probes.json');
}

/** Results of `seamless test`, by target id ("provider/model"). */
export function loadProbes() {
  try {
    return JSON.parse(fs.readFileSync(probesPath(), 'utf8')).results || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read ${probesPath()}: ${err.message}`);
  }
}

export function saveProbes(results) {
  writePrivate(probesPath(), { version: 1, results: { ...loadProbes(), ...results } });
}

function writePrivate(file, data) {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Loads the provider catalog. A catalog at ~/.seamless/providers.json (or
 * SEAMLESS_CATALOG) replaces the bundled one, so the list can be updated
 * without a new release.
 */
export function loadCatalog() {
  const candidates = [process.env.SEAMLESS_CATALOG, path.join(homeDir(), 'providers.json'), BUNDLED_CATALOG];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateCatalog(catalog, file);
    return catalog;
  }
  throw new Error('No provider catalog found');
}

function validateCatalog(catalog, file) {
  if (!Array.isArray(catalog.providers)) throw new Error(`${file}: "providers" must be an array`);
  for (const [part, weight] of Object.entries(catalog.ranking?.weights || {})) {
    if (typeof weight !== 'number' || weight < 0) throw new Error(`${file}: ranking weight "${part}" must be a number of 0 or more`);
  }
  for (const p of catalog.providers) {
    if (!p.id || !p.baseUrl || !Array.isArray(p.models) || p.models.length === 0) {
      throw new Error(`${file}: provider ${p.id || '(no id)'} needs id, baseUrl and at least one model`);
    }
  }
}

/** The API key for a provider: environment variable first, then the saved config. */
export function keyFor(provider, config) {
  const fromEnv = provider.auth?.env && process.env[provider.auth.env];
  return fromEnv || config.keys?.[provider.id] || null;
}

export function isUsable(provider, config) {
  return !provider.disabled && (!provider.auth?.required || Boolean(keyFor(provider, config)));
}
