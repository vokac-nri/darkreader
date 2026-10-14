import '../support/polyfills';
import {DEFAULT_THEME} from '../../../src/defaults';
import type {DynamicThemeFix} from '../../../src/definitions';
import {createOrUpdateDynamicTheme, removeDynamicTheme} from '../../../src/inject/dynamic-theme';
import {getContrastRatio, parseColorWithCache, rgbToHSL} from '../../../src/utils/color';
import {multiline, timeout, waitForEvent} from '../support/test-utils';

const theme = {...DEFAULT_THEME, minimumContrast: 4.5};
const white = {r: 255, g: 255, b: 255};

// Inline styles of `.panel` are left untouched by Dark Reader,
// which reproduces a light background that slipped through the theme
const fixes: DynamicThemeFix[] = [{
    url: ['*'],
    invert: [],
    css: '',
    ignoreInlineStyle: ['.panel'],
    ignoreImageAnalysis: [],
    ignoreCSSUrl: [],
    disableStyleSheetsProxy: false,
    disableCustomElementRegistryProxy: false,
}];

const linkStyle = '<style>.link { color: rgb(255, 200, 0); }</style>';

let container: HTMLElement;

function waitForGuard() {
    return Promise.race([
        waitForEvent('__darkreader__test__contrastGuardComplete'),
        timeout(1000),
    ]);
}

function getTextContrast(el: Element, bg = white) {
    return getContrastRatio(parseColorWithCache(getComputedStyle(el).color)!, bg);
}

beforeEach(() => {
    container = document.body;
    container.innerHTML = '';
});

afterEach(() => {
    removeDynamicTheme();
    container.innerHTML = '';
});

describe('CONTRAST GUARD', () => {
    it('should fix text that is unreadable on its background', async () => {
        container.innerHTML = multiline(
            linkStyle,
            '<div class="panel" style="background-color: white"><a class="link">Update v1.3.0</a></div>',
        );
        createOrUpdateDynamicTheme(theme, fixes, false);
        await waitForGuard();

        const link = container.querySelector('.link')!;
        expect(link.hasAttribute('data-darkreader-contrast')).toBe(true);
        expect(getTextContrast(link)).toBeGreaterThanOrEqual(4.5);
        const {h} = rgbToHSL(parseColorWithCache(getComputedStyle(link).color)!);
        expect(Math.abs(h - 47)).toBeLessThan(10);
    });

    it('should leave readable text alone', async () => {
        container.innerHTML = multiline(
            '<p class="text">Plain text</p>',
        );
        createOrUpdateDynamicTheme(theme, fixes, false);
        await waitForGuard();

        expect(container.querySelector('.text')!.hasAttribute('data-darkreader-contrast')).toBe(false);
    });

    it('should skip text over background images', async () => {
        container.innerHTML = multiline(
            linkStyle,
            '<div class="panel" style="background-image: linear-gradient(white, white)"><a class="link">Update</a></div>',
        );
        createOrUpdateDynamicTheme(theme, fixes, false);
        await waitForGuard();

        expect(container.querySelector('.link')!.hasAttribute('data-darkreader-contrast')).toBe(false);
    });

    it('should be disabled by zero minimum contrast', async () => {
        container.innerHTML = multiline(
            linkStyle,
            '<div class="panel" style="background-color: white"><a class="link">Update</a></div>',
        );
        createOrUpdateDynamicTheme({...theme, minimumContrast: 0}, fixes, false);
        await timeout(100);

        expect(container.querySelector('.link')!.hasAttribute('data-darkreader-contrast')).toBe(false);
        expect(document.querySelector('.darkreader--contrast')).toBe(null);
    });

    it('should check elements added later', async () => {
        container.innerHTML = linkStyle;
        createOrUpdateDynamicTheme(theme, fixes, false);
        await timeout(50);

        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.setAttribute('style', 'background-color: white');
        panel.innerHTML = '<a class="link">Late update</a>';
        container.appendChild(panel);
        await waitForGuard();

        expect(getTextContrast(panel.querySelector('.link')!)).toBeGreaterThanOrEqual(4.5);
    });

    it('should fix text inside shadow roots', async () => {
        container.innerHTML = '<div class="host"></div>';
        const shadowRoot = container.querySelector('.host')!.attachShadow({mode: 'open'});
        shadowRoot.innerHTML = multiline(
            linkStyle,
            '<div class="panel" style="background-color: white"><a class="link">Shadow update</a></div>',
        );
        createOrUpdateDynamicTheme(theme, fixes, false);
        await waitForGuard();

        const link = shadowRoot.querySelector('.link')!;
        expect(shadowRoot.querySelector('.darkreader--contrast')).not.toBe(null);
        expect(getTextContrast(link)).toBeGreaterThanOrEqual(4.5);
    });

    it('should rescan when the minimum contrast changes', async () => {
        container.innerHTML = multiline(
            linkStyle,
            '<div class="panel" style="background-color: white"><a class="link">Update</a></div>',
        );
        createOrUpdateDynamicTheme(theme, fixes, false);
        await waitForGuard();
        const link = container.querySelector('.link')!;
        expect(getTextContrast(link)).toBeLessThan(7);

        createOrUpdateDynamicTheme({...theme, minimumContrast: 7}, fixes, false);
        await waitForGuard();

        expect(getTextContrast(link)).toBeGreaterThanOrEqual(7);
    });

    it('should clean up when the theme is removed', async () => {
        container.innerHTML = multiline(
            linkStyle,
            '<div class="panel" style="background-color: white"><a class="link">Update</a></div>',
        );
        createOrUpdateDynamicTheme(theme, fixes, false);
        await waitForGuard();
        expect(document.querySelector('[data-darkreader-contrast]')).not.toBe(null);

        removeDynamicTheme();

        expect(document.querySelector('[data-darkreader-contrast]')).toBe(null);
        expect(document.querySelector('.darkreader--contrast')).toBe(null);
    });
});
