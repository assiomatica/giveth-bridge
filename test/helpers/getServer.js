const GanacheCLI = require('ganache-cli');
const CoverageSubprovider = require('@0xproject/sol-cov').CoverageSubprovider;

let servers = {};
module.exports = port => {
    if (servers[port]) return servers[port];

    ganache = GanacheCLI.server({
        ws: true,
        gasLimit: 6700000,
        total_accounts: 10,
    });

    if (process.env.SOLIDITY_COVERAGE) {
        // const accounts = await web3.eth.getAccounts();

        const artifactsPath = 'build/artifacts';
        const contractsPath = '';
        // Some calls might not have `from` address specified. Nevertheless - transactions need to be submitted from an address with at least some funds. defaultFromAddress is the address that will be used to submit those calls as transactions from.
        const defaultFromAddress = ''; //accounts[0];
        const verbose = false;
        coverageSubprovider = new CoverageSubprovider(
            artifactsPath,
            contractsPath,
            defaultFromAddress,
            verbose,
        );

        // insert coverageSubprovider as 1st provider
        coverageSubprovider.setEngine(ganache.provider.engine); // set engine b/c we monkey patch this provider. typically called in engine.start()
        ganache.provider.engine._providers.splice(0, 0, coverageSubprovider);

        const originalClose = ganache.close;

        ganache.close = async () => {
            await coverageSubprovider.writeCoverageAsync();
            originalClose();
        };
    }

    ganache.listen(port, '127.0.0.1', err => {});

    servers[port] = ganache;
    return ganache;
};