// Loaded with HTML/DOM only

export function multiline(...lines: string[]): string {
    if (lines.length < 1) {
        return '\n';
    }
    if (lines[lines.length - 1] !== '') {
        lines.push('');
    }
    return lines.join('\n');
}

export function timeout(delay: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, delay));
}

export function waitForEvent(eventName: string): Promise<void> {
    return new Promise<void>((resolve) => {
        document.addEventListener(eventName, () => resolve(), {once: true});
    });
}

// Waits for repeated events until the condition holds, or gives up after maxWait
// so the caller's assertions report the actual state
export function waitForEventUntil(eventName: string, condition: () => boolean, maxWait = 1000): Promise<void> {
    return new Promise<void>((resolve) => {
        const finish = () => {
            clearTimeout(timeoutId);
            document.removeEventListener(eventName, onEvent);
            resolve();
        };
        const onEvent = () => {
            if (condition()) {
                finish();
            }
        };
        const timeoutId = setTimeout(finish, maxWait);
        document.addEventListener(eventName, onEvent);
    });
}
