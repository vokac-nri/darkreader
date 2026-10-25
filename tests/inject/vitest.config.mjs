// @ts-check
import {playwright} from '@vitest/browser-playwright';
import {defineConfig} from 'vitest/config';

import {absolutePath} from '../../tasks/paths.js';

// Set INJECT_BROWSERS=chromium,firefox to run a subset
const allBrowsers = /** @type {const} */ (['chromium', 'firefox', 'webkit']);
const browsers = process.env.INJECT_BROWSERS
    ? allBrowsers.filter((browser) => process.env.INJECT_BROWSERS?.split(',').includes(browser))
    : allBrowsers;

export default defineConfig({
    root: absolutePath('.'),
    define: {
        __DEBUG__: false,
        __FIREFOX_MV2__: false,
        __CHROMIUM_MV2__: false,
        __CHROMIUM_MV3__: false,
        __THUNDERBIRD__: false,
        __PLUS__: false,
        __PORT__: -1,
        __TEST__: true,
        __WATCH__: false,
    },
    resolve: {
        alias: [
            {find: /^@plus\/(.*)$/, replacement: absolutePath('src/stubs/$1')},
        ],
    },
    test: {
        include: ['tests/inject/**/*.tests.ts'],
        globals: true,
        setupFiles: ['tests/inject/support/polyfills.ts'],
        globalSetup: ['tests/inject/support/global-setup.js'],
        browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: browsers.map((browser) => ({browser})),
        },
    },
});
