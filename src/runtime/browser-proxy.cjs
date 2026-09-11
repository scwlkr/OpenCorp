// Product test code still runs under the native OS sandbox. This compatibility
// shim makes Playwright use the one permitted proxy; removing it cannot grant
// network access because direct connections remain denied by the kernel.
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads execute synchronously as CommonJS. */
/* global require, process, URL */
const { createRequire } = require('node:module');
const local = createRequire(require('node:path').join(process.cwd(), 'package.json'));
try {
  const { chromium } = local('playwright-core');
  const proxy = new URL(process.env.HTTP_PROXY);
  if (proxy.hostname !== '127.0.0.1' || proxy.username !== 'opencorp') throw new Error('Invalid owned test proxy');
  const configuration = { server: `${proxy.protocol}//${proxy.host}`, username: proxy.username, password: proxy.password, bypass: '<-loopback>' };
  const launch = chromium.launch.bind(chromium);
  const persistent = chromium.launchPersistentContext.bind(chromium);
  chromium.launch = options => launch({ ...options, proxy: configuration });
  chromium.launchPersistentContext = (directory, options) => persistent(directory, { ...options, proxy: configuration });
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
