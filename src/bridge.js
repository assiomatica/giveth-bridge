import logger from 'winston';
import Datastore from 'nedb';
import path from 'path';
import Relayer from './Relayer';
import Verifyer from './Verifyer';
import './promise-polyfill';

logger.level = process.env.LOG_LEVEL || 'info';

// replace log function to prettyPrint objects
logger.origLog = logger.log;
logger.log = function(level, ...args) {
    const newArgs = args.map(a => {
        if (typeof a === 'object' && !(a instanceof Error)) {
            return JSON.stringify(a, null, 2);
        }

        return a;
    });

    return this.origLog(level, ...newArgs);
};

/**
 * used for testing
 */
export const testBridge = (config, writeDB = false) => {
    const db = {};
    db.bridge = new Datastore(
        writeDB ? path.join(__dirname, config.dataDir, 'bridge-data.db') : undefined,
    );
    db.bridge.loadDatabase();
    db.txs = new Datastore(
        writeDB ? path.join(__dirname, config.dataDir, 'bridge-txs.db') : undefined,
    );
    db.txs.loadDatabase();

    const relayer = new Relayer(config, db);
    const verifyer = new Verifyer(relayer.homeWeb3, relayer.foreignWeb3, config, db);

    return { db, relayer, verifyer };
};

/* istanbul ignore next */
export default (config) => {
    const db = {};
    db.bridge = new Datastore(path.join(config.dataDir, 'bridge-data.db'));
    db.bridge.loadDatabase();
    db.txs = new Datastore(path.join(config.dataDir, 'bridge-txs.db'));
    db.txs.loadDatabase();

    const relayer = new Relayer(config, db);
    const verifyer = new Verifyer(relayer.homeWeb3, relayer.foreignWeb3, config, db);

    relayer.loadBridgeData().then(bridgeData => {
        if (bridgeData.homeContractAddress !== config.homeBridge) {
            throw new Error('stored homeBridge address does not match config.homeBridge');
        }
        if (bridgeData.foreignContractAddress !== config.foreignBridge) {
            throw new Error('stored foreignBridge address does not match config.foreignBridge');
        }
        relayer.start();

        setTimeout(() => verifyer.start(), config.pollTime / 2);
    });
};
