const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

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
