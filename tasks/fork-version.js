// @ts-check
import {readFile, writeFile} from 'node:fs/promises';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

/**
 * @param {string} version
 * @returns {string}
 */
export function incrementMinorVersion(version) {
    if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error('Fork version must use major.minor.patch format.');
    }
    const parts = version.split('.').map(Number);
    if (parts.some((part) => part > 65535) || parts[1] === 65535) {
        throw new Error('Fork version exceeds the Firefox version component limit (65535).');
    }
    return `${parts[0]}.${parts[1] + 1}.0`;
}

/**
 * @param {URL} file
 * @returns {Promise<string>}
 */
export async function bumpForkVersion(file) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.version = incrementMinorVersion(data.version);
    await writeFile(file, `${JSON.stringify(data, null, 4)}\n`);
    return data.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(await bumpForkVersion(new URL('../fork-version.json', import.meta.url)));
}
