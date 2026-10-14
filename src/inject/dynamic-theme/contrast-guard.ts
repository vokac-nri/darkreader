import type {Theme} from '../../definitions';
import {forEach} from '../../utils/array';
import type {RGBA} from '../../utils/color';
import {blendColors, getContrastRatio, getRelativeLuminance, hslToRGB, parseColorWithCache, rgbToHSL, rgbToHexString} from '../../utils/color';
import {addReadyStateCompleteListener, createOptimizedTreeObserver, iterateShadowHosts, removeNode} from '../utils/dom';

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
    intersectionObserver = new IntersectionObserver(onIntersection, {rootMargin: '200px'});
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
    const bg = getEffectiveBackground(el, style);
    if (!bg || hasFilter(el)) {
        return null;
    }
    const threshold = theme!.minimumContrast;
    if (getContrastRatio(blendColors(fg, bg), bg) >= threshold) {
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

// Walks up the ancestors and blends their background colors until an opaque one is found.
// Returns null when the background can't be known (images, gradients, transparent iframe).
function getEffectiveBackground(el: Element, style: CSSStyleDeclaration): RGBA | null {
    const layers: RGBA[] = [];
    let node: Element | null = el;
    let s = style;
    while (node) {
        if (s.backgroundImage !== 'none') {
            return null;
        }
        const color = parseColorWithCache(s.backgroundColor);
        if (color && color.a !== 0) {
            layers.push(color);
            if (color.a == null || color.a >= 1) {
                break;
            }
        }
        node = getParent(node);
        if (node) {
            s = getComputedStyle(node);
        }
    }
    if (!node) {
        return null;
    }
    let bg = layers.pop()!;
    while (layers.length > 0) {
        bg = blendColors(layers.pop()!, bg);
    }
    return bg;
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
