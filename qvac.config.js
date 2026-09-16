'use strict'

const path = require('path')

module.exports = {
  plugins: ['@qvac/sdk/llamacpp-embedding/plugin'],
  cacheDirectory: path.join(__dirname, 'data', 'models'),
  loggerLevel: 'info',
  loggerConsoleOutput: true,
  httpDownloadConcurrency: 3,
  registryDownloadMaxRetries: 3,
}
