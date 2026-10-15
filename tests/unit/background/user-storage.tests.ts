import {expect, jest, test} from '@jest/globals';

import UserStorage from '../../../src/background/user-storage';
import {DEFAULT_SETTINGS} from '../../../src/defaults';
import type {UserSettings} from '../../../src/definitions';

const flushPromises = async () => {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
};

describe('User storage', () => {
    let pendingWrites: Array<() => void>;
    let writes: Array<Partial<UserSettings>>;

    beforeEach(() => {
        jest.useFakeTimers();
        pendingWrites = [];
        writes = [];
        (globalThis as any).chrome = {
            runtime: {lastError: undefined},
            storage: {
                local: {
                    set: jest.fn((values: Partial<UserSettings>, callback: () => void) => {
                        writes.push(values);
                        pendingWrites.push(callback);
                    }),
                },
            },
        };
    });

    afterEach(() => {
        jest.useRealTimers();
        delete (globalThis as any).chrome;
    });

    test('settings changed during an in-flight save are written after it finishes', async () => {
        UserStorage.settings = {...DEFAULT_SETTINGS, syncSettings: false, enabled: true};
        UserStorage.saveSettings();
        jest.advanceTimersByTime(1000);
        await flushPromises();
        expect(writes.length).toBe(1);
        expect(writes[0].enabled).toBe(true);

        // Change settings while the first write is still pending
        UserStorage.settings = {...UserStorage.settings, enabled: false};
        UserStorage.saveSettings();
        jest.advanceTimersByTime(1000);
        await flushPromises();
        expect(writes.length).toBe(1);

        // Finishing the first write lets the queued save write the latest settings
        pendingWrites.shift()!();
        await flushPromises();
        expect(writes.length).toBe(2);
        expect(writes[1].enabled).toBe(false);

        pendingWrites.shift()!();
        await flushPromises();
    });
});
