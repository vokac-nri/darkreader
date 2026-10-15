import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {bumpForkVersion, incrementMinorVersion} from '../../tasks/fork-version.js';

test('minor releases reset the patch and stay independent of upstream versions', () => {
    assert.equal(incrementMinorVersion('4.9.133'), '4.10.0');
    assert.equal(incrementMinorVersion('4.10.0'), '4.11.0');
    assert.equal(incrementMinorVersion('0.0.0'), '0.1.0');
});

test('invalid versions and Firefox component overflow are rejected', () => {
    for (const version of [undefined, null, 4, '4.9', '4.9.1-beta', '04.9.1', '4.65535.0', '65536.0.0', '1.0.65536']) {
        assert.throws(() => incrementMinorVersion(version));
    }
    assert.equal(incrementMinorVersion('65535.65534.65535'), '65535.65535.0');
});

test('the tracked version persists across bumps and invalid data is left intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'darkreader-fork-version-'));
    try {
        const versionFile = pathToFileURL(join(dir, 'fork-version.json'));
        await writeFile(versionFile, '{"version":"4.9.133"}\n');
        assert.equal(await bumpForkVersion(versionFile), '4.10.0');
        assert.deepEqual(JSON.parse(await readFile(versionFile, 'utf8')), {version: '4.10.0'});
        assert.equal(await bumpForkVersion(versionFile), '4.11.0');

        await writeFile(versionFile, '{"version":"invalid"}\n');
        await assert.rejects(bumpForkVersion(versionFile));
        assert.equal(await readFile(versionFile, 'utf8'), '{"version":"invalid"}\n');
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
