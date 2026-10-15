// @ts-check
import {createEchoServer} from './echo-server.js';

// Serves CORS resources for tests that load stylesheets and images from another origin
const corsServerPort = 9966;

export async function setup() {
    const server = await createEchoServer(corsServerPort);
    return () => server.close();
}
