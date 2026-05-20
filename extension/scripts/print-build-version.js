#!/usr/bin/env node
// Print the computed build version (version.buildNumber-gitHash)
// derived by webpack and stored in .di2va-build.json. Used by the
// package:firefox / package:source npm scripts so the zip filenames
// match the version shown in the in-page Debug panel.
const path = require('path');
const fs = require('fs');

const statePath = path.resolve(__dirname, '..', '.di2va-build.json');
if (!fs.existsSync(statePath)) {
  // Fallback to manifest version when no build has been run yet.
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8')
  );
  process.stdout.write(manifest.version);
  return;
}

const meta = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const parts = [meta.version || '0.0.0'];
if (Number.isFinite(meta.buildNumber)) parts.push(String(meta.buildNumber));
const base = parts.join('.');
const suffix = meta.gitHash ? `-${meta.gitHash}` : '';
process.stdout.write(`${base}${suffix}`);
