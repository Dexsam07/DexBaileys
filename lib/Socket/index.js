import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeDexSocket } from './dex.js';
// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    return makeDexSocket(newConfig);
};
export default makeWASocket;
//# sourceMappingURL=index.js.map