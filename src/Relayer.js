import Web3 from 'web3';
import logger from 'winston';
import uuidv4 from 'uuid/v4';
import GivethBridge from './GivethBridge';
import ForeignGivethBridge from './ForeignGivethBridge';
import getGasPrice from './gasPrice';

const BridgeData = {
    homeContractAddress: '',
    foreignContractAddress: '',
    homeBlockLastRelayed: 0,
    foreignBlockLastRelayed: 0,
};

export class Tx {
    constructor(txHash, toHomeBridge, data = {}) {
        this.txHash = txHash;
        this.toHomeBridge = toHomeBridge;
        // pending - tx submitted
        // confirmed - tx confirmend and correct number of blocks have passed for the network (config values)
        // failed - tx submitted and failed and correct number of blocks have passed for the network (config values)
        // failed-send - tx failed on send
        this.status = 'pending';
        Object.assign(this, data);
    }
}

export default class Relayer {
    constructor(homeWeb3, foreignWeb3, nonceTracker, config, db) {
        this.homeWeb3 = homeWeb3;
        this.foreignWeb3 = foreignWeb3;
        this.account = homeWeb3.eth.accounts.wallet[0];
        this.nonceTracker = nonceTracker;

        this.homeBridge = new GivethBridge(
            this.homeWeb3,
            this.foreignWeb3,
            config.homeBridge,
            config.foreignBridge,
        );
        this.foreignBridge = new ForeignGivethBridge(this.foreignWeb3, config.foreignBridge);

        this.db = db;
        this.config = config;
        this.pollingPromise;
        this.bridgeData;
    }

    /* istanbul ignore next */
    start() {
        this.loadBridgeData().then(() => {
            const intervalId = setInterval(() => {
                if (this.pollingPromise) {
                    this.pollingPromise.finally(() => this.poll());
                } else {
                    this.poll();
                }
            }, this.config.pollTime);

            this.poll();
        });
    }

    sendForeignTx(txData, gasPrice) {
        const { sender, mainToken, amount, data, homeTx } = txData;

        if (!txData.sideToken) {
            txData.status = 'failed-send';
            txData.error = 'No sideToken for mainToken';
            this.updateTxData(new Tx(`None-${uuidv4()}`, false, txData));
            return Promise.resolve();
        }

        let nonce;
        let txHash;
        return this.nonceTracker
            .obtainNonce()
            .then(n => {
                nonce = n;
                return this.foreignBridge.bridge
                    .deposit(sender, mainToken, amount, homeTx, data, {
                        from: this.account.address,
                        nonce,
                        gasPrice,
                    })
                    .on('transactionHash', transactionHash => {
                        txHash = transactionHash;
                        this.nonceTracker.releaseNonce(nonce);
                        this.updateTxData(new Tx(transactionHash, false, txData));
                    });
            })
            .catch((err, receipt, x) => {
                logger.debug('ForeignBridge tx error ->', err, receipt, txHash, x);

                // if we have a txHash, then we will pick up the failure in the Verifyer
                if (!txHash) {
                    this.nonceTracker.releaseNonce(nonce, false, false);
                    txData.error = err;
                    txData.status = 'failed-send';
                    this.updateTxData(new Tx(`None-${uuidv4()}`, false, txData));
                }
            });
    }

    sendHomeTx({ recipient, token, amount, txHash }, gasPrice) {
        let nonce;
        let homeTxHash;
        return this.nonceTracker
            .obtainNonce(true)
            .then(n => {
                nonce = n;
                return this.homeBridge.bridge
                    .authorizePayment('', txHash, recipient, token, amount, 0, {
                        from: this.account.address,
                        nonce,
                        gasPrice,
                    })
                    .on('transactionHash', transactionHash => {
                        this.nonceTracker.releaseNonce(nonce, true, true);
                        this.updateTxData(
                            new Tx(transactionHash, true, {
                                foreignTx: txHash,
                                recipient,
                                token,
                                amount,
                            }),
                        );
                        homeTxHash = transactionHash;
                    });
            })
            .catch((err, receipt) => {
                logger.debug('HomeBridge tx error ->', err, receipt, homeTxHash);

                // if we have a homeTxHash, then we will pick up the failure in the Verifyer
                if (!homeTxHash) {
                    this.nonceTracker.releaseNonce(nonce, true, false);
                    this.updateTxData(
                        new Tx(`None-${uuidv4()}`, true, {
                            foreignTx: txHash,
                            recipient,
                            token,
                            amount,
                            status: 'failed-send',
                            error: err,
                        }),
                    );
                }
            });
    }

    poll() {
        if (!this.bridgeData) return this.loadBridgeData().then(() => this.poll());

        let homeFromBlock;
        let homeToBlock;
        let homeGasPrice;
        let foreignFromBlock;
        let foreignToBlock;
        let foreignGasPrice;

        this.pollingPromise = Promise.all([
            this.homeWeb3.eth.getBlockNumber(),
            this.foreignWeb3.eth.getBlockNumber(),
            getGasPrice(this.config, true),
            getGasPrice(this.config, false),
        ])
            .then(([homeBlock, foreignBlock, homeGP, foreignGP]) => {
                const { homeBlockLastRelayed, foreignBlockLastRelayed } = this.bridgeData;
                homeGasPrice = homeGP;
                foreignGasPrice = foreignGP;

                homeFromBlock = homeBlockLastRelayed ? homeBlockLastRelayed + 1 : 0;
                homeToBlock = homeBlock - this.config.homeConfirmations;
                foreignFromBlock = foreignBlockLastRelayed ? foreignBlockLastRelayed + 1 : 0;
                foreignToBlock = foreignBlock - this.config.foreignConfirmations;

                return Promise.all([
                    this.homeBridge.getRelayTransactions(homeFromBlock, homeToBlock),
                    this.foreignBridge.getRelayTransactions(foreignFromBlock, foreignToBlock),
                ]);
            })
            .then(([toForeignTxs = [], toHomeTxs = []]) => {
                const foreignPromises = toForeignTxs.map(t =>
                    this.sendForeignTx(t, foreignGasPrice),
                );
                const homePromises = toHomeTxs.map(t => this.sendHomeTx(t, homeGasPrice));

                if (this.config.isTest) {
                    return Promise.all([...foreignPromises, ...homePromises]);
                }
            })
            .then(() => {
                this.bridgeData.homeBlockLastRelayed = homeToBlock;
                this.bridgeData.foreignBlockLastRelayed = foreignToBlock;
                this.updateBridgeData(this.bridgeData);
            })
            .catch(err => {
                logger.error('Error occured ->', err);
                this.bridgeData.homeBlockLastRelayed = homeFromBlock;
                this.bridgeData.foreignBlockLastRelayed = foreignFromBlock;
                this.updateBridgeData(this.bridgeData);
            })
            .finally(() => (this.pollingPromise = undefined));

        return this.pollingPromise;
    }

    loadBridgeData() {
        const bridgeData = Object.assign({}, BridgeData);

        return new Promise((resolve, reject) => {
            this.db.bridge.findOne({}, (err, doc) => {
                if (err) {
                    logger.error('Error loading bridge-config.db');
                    reject(err);
                    process.exit();
                }

                if (!doc) {
                    doc = {
                        homeContractAddress: this.config.homeBridge,
                        foreignContractAddress: this.config.foreignBridge,
                        homeBlockLastRelayed: this.config.homeBridgeDeployBlock,
                        foreignBlockLastRelayed: this.config.foreignBridgeDeployBlock,
                    };
                    this.updateBridgeData(doc);
                }

                this.bridgeData = Object.assign(bridgeData, doc);
                resolve(this.bridgeData);
            });
        });
    }

    updateTxData(data) {
        const { txHash } = data;
        this.db.txs.update({ txHash }, data, { upsert: true }, err => {
            if (err) {
                logger.error('Error updating bridge-txs.db ->', err, data);
            }
        });
    }

    updateBridgeData(data) {
        this.db.bridge.update({ _id: data._id }, data, { upsert: true }, err => {
            if (err) logger.error('Error updating bridge-config.db ->', err, data);
        });
    }
}
