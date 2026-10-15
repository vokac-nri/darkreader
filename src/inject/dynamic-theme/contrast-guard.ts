import type {Theme} from '../../definitions';
import {forEach} from '../../utils/array';
import type {RGBA} from '../../utils/color';
import {blendColors, getContrastRatio, getRelativeLuminance, hslToRGB, parseColorWithCache, rgbToHSL, rgbToHexString} from '../../utils/color';
import {addReadyStateCompleteListener, createOptimizedTreeObserver, iterateShadowHosts, removeNode} from '../utils/dom';

import {getCachedImageDetails} from './modify-css';

declare const __TEST__: boolean;

// The Contrast Guard runs after the dynamic theme has been applied.
// It compares the final text color of visible elements with the background
// behind them and adjusts the text lightness when the WCAG contrast ratio
// falls below the theme's `minimumContrast`.

const FIX_ATTR = 'data-darkreader-contrast';
const STYLE_CLASS = 'darkreader--contrast';
const FRAME_BUDGET_MS = 6;
const RESCAN_DELAY_MS = 300;
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'OPTION']);

type GuardRoot = Document | ShadowRoot;

interface RootState {
    style: HTMLStyleElement | null;
    observer: {disconnect: () => void};
}

let theme: Theme | null = null;
let isRunning = false;
let intersectionObserver: IntersectionObserver | null = null;
const roots = new Map<GuardRoot, RootState>();
const queue = new Set<Element>();
let frameId: number | null = null;
let rescanTimeoutId: ReturnType<typeof setTimeout> | null = null;
let hasPendingStart = false;

const fixIds = new Map<string, number>();
let fixRules = '';
let fixRulesChanged = false;

// Per-slice cache of whether an element or one of its ancestors has a CSS filter
const filterCache = new Map<Element, boolean>();

export function runContrastGuard($theme: Theme): void {
    theme = $theme;
    if (!(theme.minimumContrast > 0)) {
        stopContrastGuard();
        return;
    }
    if (isRunning) {
        rescanContrastGuard();
        return;
    }
    if (hasPendingStart) {
        return;
    }
    hasPendingStart = true;
    // Reading computed styles forces a layout, avoid it until all the styles are loaded
    addReadyStateCompleteListener(() => {
        hasPendingStart = false;
        if (!theme || !(theme.minimumContrast > 0) || isRunning) {
            return;
        }
        start();
    });
}

function start() {
    isRunning = true;
    // No margin: the background is found by hit testing, which only works for text on screen
    intersectionObserver = new IntersectionObserver(onIntersection);
    watchRoot(document);
    iterateShadowHosts(document.documentElement, (host) => watchRoot(host.shadowRoot!));
}

export function rescanContrastGuard(): void {
    if (!isRunning) {
        return;
    }
    if (rescanTimeoutId) {
        clearTimeout(rescanTimeoutId);
    }
    rescanTimeoutId = setTimeout(() => {
        rescanTimeoutId = null;
        if (!isRunning) {
            return;
        }
        // Elements that are already fixed keep their fix until they get checked again,
        // so that the page doesn't flash unreadable text in between
        intersectionObserver!.disconnect();
        roots.forEach((_, root) => observeCandidates(root));
    }, RESCAN_DELAY_MS);
}

export function watchContrastGuardRoot(root: ShadowRoot): void {
    if (isRunning) {
        watchRoot(root);
    }
}

function watchRoot(root: GuardRoot) {
    if (roots.has(root)) {
        return;
    }
    const observer = createOptimizedTreeObserver(root, {
        onMinorMutations: (_, {additions}) => additions.forEach((el) => observeCandidates(el)),
        onHugeMutations: (r) => observeCandidates(r),
    });
    roots.set(root, {style: null, observer});
    observeCandidates(root);
}

export function stopContrastGuard(): void {
    theme = null;
    hasPendingStart = false;
    if (!isRunning) {
        return;
    }
    isRunning = false;
    if (rescanTimeoutId) {
        clearTimeout(rescanTimeoutId);
        rescanTimeoutId = null;
    }
    if (frameId) {
        cancelAnimationFrame(frameId);
        frameId = null;
    }
    intersectionObserver?.disconnect();
    intersectionObserver = null;
    queue.clear();
    roots.forEach(({style, observer}, root) => {
        observer.disconnect();
        removeNode(style);
        forEach(root.querySelectorAll(`[${FIX_ATTR}]`), (el) => el.removeAttribute(FIX_ATTR));
    });
    roots.clear();
    fixIds.clear();
    fixRules = '';
    fixRulesChanged = false;
    filterCache.clear();
}

function isCandidateParent(el: Element) {
    return !SKIPPED_TAGS.has(el.tagName) && !(el instanceof SVGElement) && !el.classList.contains('darkreader');
}

// Candidates are the elements that directly contain non-blank text
function observeCandidates(root: Node) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last: Element | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent === last || !(node as Text).data.trim()) {
            continue;
        }
        last = parent;
        if (isCandidateParent(parent)) {
            intersectionObserver!.observe(parent);
        }
    }
}

function onIntersection(entries: IntersectionObserverEntry[]) {
    entries.forEach(({target, isIntersecting}) => {
        if (isIntersecting) {
            intersectionObserver!.unobserve(target);
            queue.add(target);
        }
    });
    if (queue.size > 0) {
        scheduleProcessing();
    }
}

function scheduleProcessing() {
    if (frameId == null) {
        frameId = requestAnimationFrame(processQueue);
    }
}

function processQueue() {
    frameId = null;
    if (!isRunning) {
        return;
    }
    const deadline = performance.now() + FRAME_BUDGET_MS;
    for (const el of queue) {
        queue.delete(el);
        if (el.isConnected) {
            checkElement(el);
        }
        if (performance.now() > deadline) {
            break;
        }
    }
    filterCache.clear();
    flushRules();
    if (queue.size > 0) {
        scheduleProcessing();
    } else if (__TEST__) {
        document.dispatchEvent(new CustomEvent('__darkreader__test__contrastGuardComplete'));
    }
}

function checkElement(el: Element) {
    // The previous fix must be off to measure the color the page itself produces.
    // Removing and setting it back happens synchronously, so nothing gets painted in between.
    const prevId = el.getAttribute(FIX_ATTR);
    if (prevId != null) {
        el.removeAttribute(FIX_ATTR);
    }
    const fix = getContrastFix(el);
    if (fix) {
        el.setAttribute(FIX_ATTR, String(getFixId(fix)));
    }
}

function getContrastFix(el: Element): string | null {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden') {
        return null;
    }
    const fg = parseColorWithCache(style.color);
    if (!fg || fg.a === 0) {
        return null;
    }
    // Gradient text and the like are painted with something other than `color`
    const textFill = style.getPropertyValue('-webkit-text-fill-color');
    if (textFill && textFill !== style.color) {
        return null;
    }
    if (style.getPropertyValue('background-clip') === 'text' || style.getPropertyValue('-webkit-background-clip') === 'text') {
        return null;
    }
    const backgrounds = getEffectiveBackgrounds(el, style);
    if (!backgrounds || hasFilter(el)) {
        return null;
    }
    // A gradient can put several colors behind the text, the least readable one decides
    let bg = backgrounds[0];
    let ratio = Infinity;
    for (const candidate of backgrounds) {
        const r = getContrastRatio(blendColors(fg, candidate), candidate);
        if (r < ratio) {
            bg = candidate;
            ratio = r;
        }
    }
    const threshold = theme!.minimumContrast;
    if (ratio >= threshold) {
        return null;
    }
    return rgbToHexString(findReadableColor(fg, bg, threshold));
}

function getParent(el: Element): Element | null {
    if (el.assignedSlot) {
        return el.assignedSlot;
    }
    if (el.parentElement) {
        return el.parentElement;
    }
    const parent = el.parentNode;
    return parent instanceof ShadowRoot ? parent.host : null;
}

// Colors that can be painted at one spot of a background layer, several for gradients
type Layer = RGBA[];

enum LayerResult {
    Translucent,
    Opaque,
    Unknown
}

const REPLACED_TAGS = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT']);
const MAX_BACKGROUND_CANDIDATES = 16;
const black: RGBA = {r: 0, g: 0, b: 0, a: 1};
const white: RGBA = {r: 255, g: 255, b: 255, a: 1};

function isOpaque(color: RGBA) {
    return color.a == null || color.a >= 1;
}

interface TextBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

// The center of the element's first line of text, clamped to the viewport
function getTextBox(el: Element): TextBox | null {
    let rect: DOMRect | null = null;
    for (let node = el.firstChild; node; node = node.nextSibling) {
        if (node instanceof Text && node.data.trim()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            rect = range.getClientRects()[0] ?? null;
            break;
        }
    }
    if (!rect || rect.width === 0 || rect.height === 0) {
        rect = el.getBoundingClientRect();
    }
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, document.documentElement.clientWidth);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, document.documentElement.clientHeight);
    if (left >= right || top >= bottom) {
        return null;
    }
    return {x: (left + right) / 2, y: (top + bottom) / 2, width: rect.width, height: rect.height};
}

// Elements painted under the text, from the element itself down to the page.
// Unlike the ancestors, this includes positioned siblings and cards placed behind the text.
function getElementsBehind(el: Element, box: TextBox | null): Element[] {
    if (box) {
        const root = el.getRootNode() as Document | ShadowRoot;
        if (typeof root.elementsFromPoint === 'function') {
            const stack = root.elementsFromPoint(box.x, box.y);
            const index = stack.indexOf(el);
            if (index >= 0) {
                return stack.slice(index);
            }
        }
    }
    // Text that can't be hit tested (off-screen, `pointer-events: none`) falls back to the ancestors
    const ancestors: Element[] = [];
    for (let node: Element | null = el; node; node = getParent(node)) {
        ancestors.push(node);
    }
    return ancestors;
}

// Gradient colors come serialized as rgb()/rgba() in computed styles.
// Images use the analysis the theme already made, when the image wasn't replaced.
function getImageColor(url: string): RGBA | null {
    const details = getCachedImageDetails(url);
    if (!details || details.isTransparent) {
        return null;
    }
    if (details.solidColor) {
        return details.solidColor;
    }
    if (details.isLight) {
        return white;
    }
    return details.isDark ? black : null;
}

function getImageColors(backgroundImage: string): RGBA[] | null {
    const colors: RGBA[] = [];
    let isUnknown = false;
    const withoutURLs = backgroundImage.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, __, url: string) => {
        const color = getImageColor(url);
        if (color) {
            colors.push(color);
        } else {
            isUnknown = true;
        }
        return '';
    });
    if (isUnknown) {
        return null;
    }
    if (withoutURLs.includes('gradient')) {
        const stops = withoutURLs.match(/rgba?\([^)]*\)/g);
        if (!stops) {
            return null;
        }
        for (const stop of stops) {
            const color = parseColorWithCache(stop);
            if (!color) {
                return null;
            }
            colors.push(color);
        }
    }
    return colors.length > 0 ? colors : null;
}

function addBackgroundLayers(s: CSSStyleDeclaration, layers: Layer[]): LayerResult {
    if (s.backgroundImage !== 'none') {
        const colors = getImageColors(s.backgroundImage);
        if (!colors) {
            return LayerResult.Unknown;
        }
        layers.push(colors);
        if (colors.every(isOpaque)) {
            return LayerResult.Opaque;
        }
    }
    const color = parseColorWithCache(s.backgroundColor);
    if (color && color.a !== 0) {
        layers.push([color]);
        if (isOpaque(color)) {
            return LayerResult.Opaque;
        }
    }
    return LayerResult.Translucent;
}

// A positioned pseudo-element at least as big as the text is likely a backdrop for it
function isPseudoBackdrop(s: CSSStyleDeclaration, box: TextBox | null) {
    if (s.content === 'none' || s.content === 'normal') {
        return false;
    }
    if (s.position !== 'absolute' && s.position !== 'fixed') {
        return false;
    }
    if (!box) {
        return false;
    }
    return parseFloat(s.width) >= box.width && parseFloat(s.height) >= box.height;
}

// Blends the backgrounds of everything painted under the text until an opaque layer is found.
// Returns null when the background can't be known (photos, replaced elements, filters, transparent iframe).
function getEffectiveBackgrounds(el: Element, style: CSSStyleDeclaration): RGBA[] | null {
    const box = getTextBox(el);
    const layers: Layer[] = [];
    let isOpaqueFound = false;
    for (const node of getElementsBehind(el, box)) {
        if (REPLACED_TAGS.has(node.tagName) || (node instanceof SVGElement && node !== el)) {
            return null;
        }
        const s = node === el ? style : getComputedStyle(node);
        if (s.opacity === '0') {
            continue;
        }
        if (node !== el && s.filter !== 'none') {
            return null;
        }
        let result = LayerResult.Translucent;
        for (const pseudo of ['::after', '::before']) {
            const ps = getComputedStyle(node, pseudo);
            if (isPseudoBackdrop(ps, box)) {
                result = addBackgroundLayers(ps, layers);
                if (result !== LayerResult.Translucent) {
                    break;
                }
            }
        }
        if (result === LayerResult.Translucent) {
            result = addBackgroundLayers(s, layers);
        }
        if (result === LayerResult.Unknown) {
            return null;
        }
        if (result === LayerResult.Opaque) {
            isOpaqueFound = true;
            break;
        }
    }
    if (!isOpaqueFound) {
        return null;
    }
    let backgrounds = layers.pop()!;
    while (layers.length > 0) {
        const layer = layers.pop()!;
        const blended: RGBA[] = [];
        for (const top of layer) {
            for (const bottom of backgrounds) {
                blended.push(blendColors(top, bottom));
            }
        }
        backgrounds = blended.slice(0, MAX_BACKGROUND_CANDIDATES);
    }
    return backgrounds;
}

// Colors inside filtered elements (e.g. the inverted ones) are not what gets painted
function hasFilter(el: Element): boolean {
    if (filterCache.has(el)) {
        return filterCache.get(el)!;
    }
    const parent = getParent(el);
    const result = getComputedStyle(el).filter !== 'none' || (parent ? hasFilter(parent) : false);
    filterCache.set(el, result);
    return result;
}

// Keeps the hue and saturation of the text,
// and moves its lightness the least amount needed to reach the threshold
function findReadableColor(fg: RGBA, bg: RGBA, threshold: number): RGBA {
    const bgLum = getRelativeLuminance(bg);
    const maxDarkLum = (bgLum + 0.05) / threshold - 0.05;
    const minLightLum = threshold * (bgLum + 0.05) - 0.05;
    const canDarken = maxDarkLum >= 0;
    const canLighten = minLightLum <= 1;

    if (!canDarken && !canLighten) {
        const black = {r: 0, g: 0, b: 0, a: 1};
        const white = {r: 255, g: 255, b: 255, a: 1};
        return getContrastRatio(white, bg) > getContrastRatio(black, bg) ? white : black;
    }

    const toLight = canDarken && canLighten
        ? getRelativeLuminance(fg) > bgLum
        : canLighten;
    const {h, s, l} = rgbToHSL(fg);
    let near = l;
    let far = toLight ? 1 : 0;
    for (let i = 0; i < 16; i++) {
        const mid = (near + far) / 2;
        const lum = getRelativeLuminance(hslToRGB({h, s, l: mid}));
        const isReadable = toLight ? lum >= minLightLum : lum <= maxDarkLum;
        if (isReadable) {
            far = mid;
        } else {
            near = mid;
        }
    }
    return hslToRGB({h, s, l: far, a: 1});
}

function getFixId(color: string): number {
    let id = fixIds.get(color);
    if (id == null) {
        id = fixIds.size + 1;
        fixIds.set(color, id);
        // `:not(#\#)` adds ID specificity, so that the fix wins over the page's own `!important` colors
        fixRules += `[${FIX_ATTR}="${id}"]:not(#\\#) { color: ${color} !important; }\n`;
        fixRulesChanged = true;
    }
    return id;
}

function flushRules() {
    roots.forEach((state, root) => {
        if (state.style && state.style.isConnected && !fixRulesChanged) {
            return;
        }
        if (!fixRules) {
            return;
        }
        if (!state.style) {
            state.style = document.createElement('style');
            state.style.classList.add('darkreader', STYLE_CLASS);
            state.style.media = 'screen';
        }
        if (!state.style.isConnected) {
            const parent = root instanceof Document ? (root.head || root.documentElement) : root;
            parent.appendChild(state.style);
        }
        state.style.textContent = fixRules;
    });
    fixRulesChanged = false;
}
