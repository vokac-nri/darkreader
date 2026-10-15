import {expect, jest, test} from '@jest/globals';

import {readSyncStorage, writeSyncStorage} from '../../../src/background/utils/extension-api';

const QUOTA_BYTES_PER_ITEM = 8192;

let stored: {[key: string]: any} = {};

beforeEach(() => {
    stored = {};
    (globalThis as any).chrome = {
        runtime: {lastError: undefined},
        storage: {
            sync: {
                QUOTA_BYTES_PER_ITEM,
                set: jest.fn((values: {[key: string]: any}, callback: () => void) => {
                    stored = {...stored, ...values};
                    callback();
                }),
                get: jest.fn((_keys: null, callback: (items: any) => void) => {
                    callback({...stored});
                }),
            },
        },
    };
});

afterEach(() => {
    delete (globalThis as any).chrome;
});

describe('Sync storage', () => {
    test('writing a large value does not modify the input object', async () => {
        const disabledFor = Array.from({length: 1000}, (_, i) => `site-${i}.example.com`);
        const values = {disabledFor, enabled: true};
        expect(JSON.stringify(disabledFor).length).toBeGreaterThan(QUOTA_BYTES_PER_ITEM);

        await writeSyncStorage(values);

        expect(Object.keys(values)).toEqual(['disabledFor', 'enabled']);
        expect(values.disabledFor).toBe(disabledFor);
        expect(values.enabled).toBe(true);

        expect(stored.disabledFor.__meta_split_count).toBeGreaterThan(1);
        expect(stored.disabledFor_0).toEqual(expect.any(String));
        expect(stored.enabled).toBe(true);
    });

    test('split values are reassembled on read', async () => {
        const disabledFor = Array.from({length: 1000}, (_, i) => `site-${i}.example.com`);
        await writeSyncStorage({disabledFor, enabled: true});

        const result = await readSyncStorage({disabledFor: [] as string[], enabled: false});

        expect(result).toEqual({disabledFor, enabled: true});
    });

    test('small values are written as is', async () => {
        await writeSyncStorage({enabled: true, syncSettings: true});
        expect(stored).toEqual({enabled: true, syncSettings: true});
    });
});
