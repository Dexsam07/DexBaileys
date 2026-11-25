import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeDexSocket } from './dex.js';
// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config,
        // a version the caller chose is left alone unless they ask for the sync too
        syncWaWebVersion: config.syncWaWebVersion ?? config.version === undefined
    };
    return makeDexSocket(newConfig);
};
export default makeWASocket;
//# sourceMappingURL=index.js.map