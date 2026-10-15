import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {test} from 'node:test';

import bundleManifest from '../../tasks/bundle-manifest.js';
import {setRootDir} from '../../tasks/paths.js';

test('Firefox releases use the fork version while other build modes retain upstream behavior', async () => {
    const cwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'darkreader-manifest-'));
    try {
        await mkdir(join(dir, 'src'));
        await writeFile(join(dir, 'src/manifest.json'), JSON.stringify({
            version: '4.9.999',
            permissions: [],
        }));
        await writeFile(join(dir, 'src/manifest-firefox.json'), '{}');
        await writeFile(join(dir, 'src/manifest-thunderbird.json'), '{}');
        await writeFile(join(dir, 'fork-version.json'), '{"version":"4.10.0"}');
        setRootDir(dir);
        process.chdir(dir);
        const platforms = {firefox: true, chrome: true, thunderbird: true};
        const manifest = async (debug, platform) => JSON.parse(await readFile(
            join(dir, 'build', debug ? 'debug' : 'release', platform, 'manifest.json'),
            'utf8'
        ));
        await bundleManifest.run({platforms, debug: false, watch: false, test: false, version: false});
        assert.equal((await manifest(false, 'firefox')).version, '4.10.0');
        assert.equal((await manifest(false, 'chrome')).version, '4.9.999');
        assert.equal((await manifest(false, 'thunderbird')).version, '4.9.999');

        await bundleManifest.run({platforms: {firefox: true}, debug: true, watch: false, test: false, version: false});
        assert.equal((await manifest(true, 'firefox')).version, '1');

        // Explicit official-signature builds must keep the upstream manifest.
        await bundleManifest.run({platforms: {firefox: true}, debug: false, watch: false, test: false, version: '4.9.999'});
        assert.equal((await manifest(false, 'firefox')).version, '4.9.999');
    } finally {
        process.chdir(cwd);
        setRootDir(cwd);
        await rm(dir, {recursive: true, force: true});
    }
});
