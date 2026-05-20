const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webpack = require('webpack');
const { execSync } = require('child_process');
const CopyPlugin = require('copy-webpack-plugin');

function safeExec(command, cwd) {
  try {
    return execSync(command, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
  } catch {
    return null;
  }
}

function collectFilesRecursively(entryPath, files = []) {
  if (!fs.existsSync(entryPath)) return files;
  const stat = fs.statSync(entryPath);

  if (stat.isFile()) {
    files.push(entryPath);
    return files;
  }

  const children = fs.readdirSync(entryPath).sort();
  for (const child of children) {
    const fullPath = path.join(entryPath, child);
    const childStat = fs.statSync(fullPath);

    if (childStat.isDirectory()) {
      if (child === 'dist' || child === 'node_modules') continue;
      collectFilesRecursively(fullPath, files);
    } else if (childStat.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function computeSourceHash(rootDir) {
  const trackedEntries = [
    path.join(rootDir, 'src'),
    path.join(rootDir, 'popup'),
    path.join(rootDir, 'options'),
    path.join(rootDir, 'manifest.json'),
    path.join(rootDir, 'package.json'),
    path.join(rootDir, 'webpack.config.js')
  ];

  const allFiles = [];
  for (const entry of trackedEntries) {
    collectFilesRecursively(entry, allFiles);
  }

  const sortedFiles = [...new Set(allFiles)].sort();
  const hash = crypto.createHash('sha1');

  for (const filePath of sortedFiles) {
    const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
    hash.update(relPath);
    hash.update('\n');
    hash.update(fs.readFileSync(filePath));
    hash.update('\n');
  }

  return hash.digest('hex');
}

function buildVersionMetadata(rootDir) {
  const statePath = path.join(rootDir, '.di2va-build.json');
  const sourceHash = computeSourceHash(rootDir);

  let previous = {
    buildNumber: 0,
    sourceHash: ''
  };

  if (fs.existsSync(statePath)) {
    try {
      previous = {
        ...previous,
        ...JSON.parse(fs.readFileSync(statePath, 'utf8'))
      };
    } catch {
      // Ignore malformed state and re-seed below.
    }
  }

  const changed = previous.sourceHash !== sourceHash;
  const buildNumber = changed ? Number(previous.buildNumber || 0) + 1 : Number(previous.buildNumber || 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  const gitHash = safeExec('git rev-parse --short HEAD', rootDir) || 'nogit';

  const nextState = {
    buildNumber,
    sourceHash,
    version: manifest.version,
    gitHash,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + '\n', 'utf8');

  return {
    buildNumber,
    sourceHash: sourceHash.slice(0, 10),
    version: manifest.version,
    gitHash,
    changed
  };
}

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  const buildMeta = buildVersionMetadata(__dirname);

  return {
    devtool: isProd ? false : 'cheap-module-source-map',

    entry: {
      'content': './src/content/main.js',
      'background': './src/background.js',
      'fit-worker': './src/fit-worker.js',
    },

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
    },

    module: {
      rules: [
        // Handle .node files (if fit-file-parser tries to load native modules)
        {
          test: /\.node$/,
          use: 'node-loader',
          type: 'javascript/auto',
        },
      ],
    },

    resolve: {
      extensions: ['.js', '.json'],
      fallback: {
        // fit-file-parser is pure JS but may reference node builtins
        fs: false,
        path: false,
        buffer: false,
      },
    },

    plugins: [
      new webpack.DefinePlugin({
        __DI2VA_BUILD__: JSON.stringify(buildMeta)
      }),
      new CopyPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'src/content/styles.css', to: 'content.css' },
          { from: 'popup', to: 'popup' },
          { from: 'options', to: 'options' },
          { from: 'icons', to: 'icons' },
        ],
      }),
    ],

    optimization: {
      minimize: isProd,
    },
  };
};
