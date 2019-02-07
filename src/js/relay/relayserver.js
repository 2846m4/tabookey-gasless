const http = require('http')
const https = require('https')
const url = require('url')
const fs = eval("require('fs')")
const Web3 = require('web3')
const utils = require('../relayclient/utils')
const eth_wallet = require('ethereumjs-wallet');
// const RelayHubApi = require('../relayclient/RelayHubApi')
const RelayHubApi = JSON.parse(fs.readFileSync(__dirname + '/../../../build/contracts/RelayHub.json')).abi
const ethTx = require('ethereumjs-tx');

// function trace() {
//     console.log(new Error().stack.match(/trace.*\n.*?(\d+)/ )[1])
// }


//client looks up 6000 blocks back for a RelayAdded. we refresh little bit faster
const lookup_limit_blocks = 6000 - 100

const KEYFILE_VERSION = "1.0"

const minBalance = 1e17
const minStake = 1e17

function serverLog() {
    let args = Array.prototype.slice.call(arguments)
    args.unshift("RELAY:")
    console.log.apply(null, args)
}

function debugLog() {
    if (!this.Verbose)
        return
    let args = Array.prototype.slice.call(arguments)
    args.unshift("RELAY:")
    console.log.apply(null, args)
}

class RelayServer {

    /**
     * create relay server
     */
    constructor(options) {

        if (!options.Url) options.Url = "http://localhost:8090"
        if (!options.EthereumNodeUrl) options.EthereumNodeUrl = "http://localhost:8545"
        if (!options.GasPricePercent) options.GasPricePercent = 10

        //eslint-disable-next-line no-func-assign
        debugLog = debugLog.bind(options)

        this.options = options

        let keyFileName = options.KeyFile || [options.WorkDir || ".", "keyfile.txt"].join("/");
        try {
            let keyfile = JSON.parse(fs.readFileSync(keyFileName).toString())
            if (keyfile.version !== KEYFILE_VERSION)
                throw Error("wrong keyfile version")
            this.key = keyfile.key
        } catch (e) {

            let gen = eth_wallet.generate()
            this.key = {
                privateKey: gen.privKey.toString('hex'),
                address: "0x" + gen.getAddress().toString('hex')
            }
            if (keyFileName) {
                fs.writeFileSync(keyFileName, JSON.stringify({
                    version: KEYFILE_VERSION,
                    key: this.key
                }))
                serverLog("written: " + keyFileName)
            }
        }
        this.relayAddr = this.key.address

        serverLog("Relay address: " + this.relayAddr)


        let httpProvider = new Web3.providers.HttpProvider(options.EthereumNodeUrl);
        // let provider = new HDWalletProvider(this.key.privateKey, httpProvider);
        this.web3 = new Web3(httpProvider)

        this.rhub = new this.web3.eth.Contract(RelayHubApi, options.RelayHubAddress)

        let defaultPort
        let createServer
        if (options.Url.startsWith("https")) {
            createServer = https.createServer
            defaultPort = 443
            if ( options.HttpsCert ) {
                let certfile = fs.readFileSync(options.HttpsCert).toString()
                options.key = certfile.match(/(---*\s*BEGIN PRIVATE[\s\S]*?---*\s*END PRIVATE.*)/)[1]
                options.cert = certfile.match(/(---*\s*BEGIN CERT[\s\S]*---*\s*END CERT.*)/)[1]
            } else {
                console.error( "Missing \"-KeyFile\" when using https" )
                process.exit(1)
            }
        } else {
            createServer = http.createServer
            defaultPort = 80
        }
        let port = options.Port || url.parse(options.Url).port || defaultPort

        // if (options.key)
        //     options.key = fs.readFileSync(options.key)
        // if (options.cert)
        //     options.cert = fs.readFileSync(options.cert)
        this.server = createServer(options, this.httpRequestHandler.bind(this))
        this.server.listen(port)

        this.sleepTimeSec = this.options.SleepTime || (this.options.ShortSleep ? 1 : 60)
        serverLog("Started relay", this.relayAddr, "url=" + this.options.Url, "listen port", port, "update interval=",this.sleepTimeSec)
        this.scheduleNextUpdate()
    }

    scheduleNextUpdate() {
        this.interv = setTimeout(this.updateStatus.bind(this), this.sleepTimeSec * 1000)
    }

    stop() {
        this.server.close()
        clearTimeout(this.interv)
    }

    writeResp(resp, status, result) {
        resp.writeHead(status, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Content-Type": "application/json"
        })
        serverLog("SERVER RESP: ", JSON.stringify(result))
        resp.write(JSON.stringify(result) + "\n")
        resp.end()
    }

    //periodic update ready status of server
    async updateStatus() {
        try {
            this.lastStatus = await this.checkStatus()
            if ( this.lastStatus != this.prevLoggedStatus ) {
                serverLog("update status: ", this.lastStatus)
                this.prevLoggedStatus = this.lastStatus
            }
        } finally {
            if ( this.sleepTimeSec>0 )
                this.scheduleNextUpdate()
        }
    }

    async checkStatus() {

        let eth = this.web3.eth
        let rhub = this.rhub.methods
        let options = this.options

        if ((await eth.getBalance(this.relayAddr)) < minBalance)
            return "insuf. bulance"

        if ((await rhub.stakeOf(this.relayAddr)) < minStake)
            return "insuf. stake"
        let curBlock = await eth.getBlockNumber()

        //must be owned, since we have a stake. check if registered.
        let fromBlock = Math.max(1,curBlock - options.LookupLimitBlocks || lookup_limit_blocks)

        let reg = await this.rhub.getPastEvents('RelayAdded', {fromBlock: fromBlock})

        if (reg.length == 0) {
            //not registered at all, or at least not in the past required time.

            if (!this.owner) {

                this.owner = await rhub.ownerOf(this.relayAddr).call()
                serverLog("owner=", this.owner)
            }
            serverLog("before register_relay. addr=", this.relayAddr, "bal=", (await this.web3.eth.getBalance(this.relayAddr)) / 1e18, "stake=", (await rhub.stakeOf(this.relayAddr).call()) / 1e18)

            let res = await this.sendTransaction(rhub.register_relay(options.GasPricePercent, options.Url, utils.zeroAddr), {from: this.relayAddr})
            serverLog("after register_relay res=", JSON.stringify(res))

            this.nonce = this.web3.eth.get
        }

        let currentNonce = await this.web3.eth.getTransactionCount(this.relayAddr)
        if ( this.nonce == undefined|| this.nonce < currentNonce) {
            serverLog("set nonce to", currentNonce, "(old=\"" + this.nonce + "\")")
            this.nonce = currentNonce
        }

        await this.currentGasPrice(true)

        return "ok"
    }


    async httpRequestHandler(req, resp) {
        if (req.method === 'OPTIONS')
            return this.writeResp(resp, 200, {})

        try {
            if (req.url === '/getaddr')
                return await this.handle_getaddr(req, resp)

            if (req.url === '/relay')
                return await this.handle_relay(req, resp)

            throw Error("Not found: " + req.url)
        } catch (e) {
            serverLog(e)
            this.writeResp(resp, 400, {error: e.toString()})
        }

    }

    handle_getaddr(req, resp) {
        if ( !this.sleepTimeSec>0 )
            this.updateStatus()

        this.writeResp(resp, 200, {
            Ready: this.lastStatus === 'ok',
            status: this.lastStatus,
            RelayServerAddress: this.relayAddr,
            RelayHubAddress: this.rhub.address,
            MinGasPrice: this.lastCurrentGasPrice
        })
    }

    async currentGasPrice(force) {
        if (force || !this.lastCurrentGasPrice) {
            let p = await this.web3.eth.getGasPrice()
            let percent = this.options.GasPricePercent || 10
            this.lastCurrentGasPrice = Math.round(p * (100 + percent) / 100)
        }
        return this.lastCurrentGasPrice
    }

    async handle_relay(req, resp) {
        if ( !this.sleepTimeSec>0 )
            this.updateStatus()

        if (this.lastStatus !== 'ok')
            return this.writeResp(resp, 200, {error: "Not ready to relay"})
        let rhub = this.rhub.methods

        let r = await this.read_body(req);

        let signature = "0x" + Buffer.from(r.signature).toString('hex');

        let res = await rhub.can_relay(this.relayAddr, r.from, r.to, r.encodedFunction, r.relayFee, r.gasPrice, r.gasLimit,
            r.RecipientNonce, signature).call();
        if (res != 0)
            throw new Error("can_relay returned: " + res)

        try {
            let reserve = parseInt(await rhub.get_gas_reserve().call());

            let gasLimit = r.gasLimit + reserve * 10;

            const toHex = this.web3.utils.toHex

            var rawTx = {
                nonce: toHex(this.nonce || 0),
                gasPrice: toHex(r.gasPrice),
                gasLimit: toHex(gasLimit),

                to: this.rhub._address,
                value: '0x00',
                data: rhub.relay(r.from, r.to, r.encodedFunction, r.relayFee, r.gasPrice, r.gasLimit, r.RecipientNonce, r.signature).encodeABI()
            }
            this.nonce++

            var tx = new ethTx(rawTx);
            var privateKey = new Buffer(this.key.privateKey, 'hex')
            tx.sign(privateKey);

            //make it match the go server's return structure
            rawTx.input = rawTx.data
            rawTx.data = undefined
            rawTx.gas = rawTx.gasLimit
            rawTx.gasLimit = undefined

            rawTx.s = tx.s.toString('hex')
            rawTx.r = tx.r.toString('hex')
            rawTx.v = tx.v.toString('hex')
            this.writeResp(resp, 200, rawTx)

            var serializedTx = tx.serialize();
            //not waiting for response..
            this.web3.eth.sendSignedTransaction(serializedTx.toString('hex'));

        } catch (e) {
            serverLog("relay ex:", e)
            this.writeResp(resp, 400, {error: e.toString()})
        }
    }


    async sendTransaction(func, options) {

        const toHex = this.web3.utils.toHex
        try {
            options = options || {}
            let gasLimit = options.gasLimit || await func.estimateGas({from: this.relayAddr});
            let gasPrice = options.gasPrice || await this.web3.eth.getGasPrice();
            var rawTx = {
                nonce: toHex(this.nonce || 0),
                gasPrice: toHex(gasPrice),
                gasLimit: toHex(gasLimit),
                to: options.to || this.rhub._address,
                from: this.relayAddr,
                value: '0x00',
                data: func.encodeABI()
            }
            this.nonce++

            var tx = new ethTx(rawTx);
            var privateKey = new Buffer(this.key.privateKey, 'hex')
            tx.sign(privateKey);
            var serializedTx = tx.serialize();
            return this.web3.eth.sendSignedTransaction(serializedTx.toString('hex'));
        } catch (e) {
            console.log(e)
        }
    }

    read_body(req) {
        return new Promise((resolve, reject) => {
            let body = ''
            req.on('data', chunk => {
                body += chunk.toString(); // convert Buffer to string
            });
            req.on('end', () => {
                try {
                    resolve(JSON.parse(body))
                } catch (e) {
                    reject(e)
                }
            });
            req.on('error', e => reject(e))  //TODO: do we ever get this?
        })
    }
}

module.exports = RelayServer