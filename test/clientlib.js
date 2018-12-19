/* globals web3 artifacts contract it before assert */

const RelayClient = require('../src/js/relayclient/relayclient');
const RelayHub = artifacts.require("./RelayHub.sol");
const SampleRecipient = artifacts.require("./SampleRecipient.sol");
const ethJsTx = require('ethereumjs-tx');

const relayAddress = "0x610bb1573d1046fcb8a70bbbd395754cd57c2b60";

const localhostOne = "http://localhost:8090"

const testutils = require('./testutils')
const register_new_relay = testutils.register_new_relay;
const postRelayHubAddress = testutils.postRelayHubAddress;

contract('RelayClient', function (accounts) {

    let rhub;
    let sr;
    let gasLess;
    let relayproc

    before(async function () {
        rhub = await RelayHub.deployed()
        sr = await SampleRecipient.deployed()

        let deposit = 100000000000;
        await sr.deposit({value: deposit});
        // let known_deposit = await rhub.balances(sr.address);
        // assert.ok(known_deposit>= deposit, "deposited "+deposit+" but found only "+known_deposit);
        gasLess = await web3.personal.newAccount("password")
        console.log("gasLess = " + gasLess);
        console.log("starting relay")

        relayproc = await testutils.startRelay(rhub, {
            verbose: process.env.relaylog,
            stake: 1e12, delay: 3600, txfee: 12, url: "asd", relayOwner: accounts[0]})

    });

    after(async function () {
        await testutils.stopRelay(relayproc)
    })

    it("test balanceOf target contract", async () => {

        let relayclient = new RelayClient(web3)
        let b1 = await relayclient.balanceOf(sr.address)
        console.log("balance before redeposit", b1.toNumber())
        let added = 200000
        await sr.deposit({ value: added });
        let b2 = await relayclient.balanceOf(sr.address)
        console.log("balance after redeposit", b2.toNumber())
        assert.equal(b2 - b1, added)

    })

    it("should send RelayHub address to server (in debug mode)", async function () {
        let res = await testutils.postRelayHubAddress(rhub.address, localhostOne);
        assert.equal("OK", res)
    });

    it("should use relay provided in constructor");

    it("should send transaction to a relay and receive a response", async function () {
        let encoded = sr.contract.emitMessage.getData("hello world");
        let gasPrice = 3;
        let to = sr.address;
        let options = {
            from: gasLess,
            to: to,
            txfee: 12,
            gas_price: gasPrice,
            gas_limit: 1000000
        }
        let relay_client_config = {
            relayUrl: localhostOne,
            relayAddress: relayAddress
        }

        let tbk = new RelayClient(web3, relay_client_config);

        let validTransaction = await tbk.relayTransaction(encoded, options);
        let txhash = "0x" + validTransaction.hash(false).toString('hex');
        let res
        do {
            res = await web3.eth.getTransactionReceipt(txhash)
            // testutils.sleep(1)
        } while (res === null)

        //validate we've got the "SampleRecipientEmitted" event
        let topic = web3.sha3('SampleRecipientEmitted(string,address,address,address)')
        assert(res.logs.find(log => log.topics.includes(topic)))

        assert.equal("0x" + validTransaction.to.toString('hex'), rhub.address.toString().toLowerCase());
        assert.equal(parseInt(validTransaction.gasPrice.toString('hex'), 16), gasPrice);

    });

    it("should relay transparently", async () => {

        let relay_client_config = {
            // relayUrl: localhostOne, 		//findrelay will find them for us..
            // relayAddress: relayAddress,

            txfee: 12,
            force_gasPrice: 3,			//override requested gas price
            force_gasLimit: 100000,		//override requested gas limit.
        }
        let relayclient = new RelayClient(web3, relay_client_config);

        relayclient.hook(SampleRecipient)

        let res = await sr.emitMessage("hello world", { from: gasLess })

        assert.equal(res.logs[0].event, "SampleRecipientEmitted")
        assert.equal(res.logs[0].args.message, "hello world")
        assert.equal(res.logs[0].args.real_sender, gasLess)
        assert.equal(res.logs[0].args.msg_sender.toLowerCase(), rhub.address.toLowerCase())
        res = await sr.emitMessage("hello again", { from: accounts[3] })
        assert.equal(res.logs[0].event, "SampleRecipientEmitted")
        assert.equal(res.logs[0].args.message, "hello again")

        assert.equal(res.logs[0].args.real_sender, accounts[3])

    })

    // This test currently has no asserts. 'auditTransaction' returns no value.
    it.skip("should send a signed raw transaction from selected relay to backup relays - in case penalty will be needed", async function () {
        let tbk = new RelayClient(web3);
        let data1 = rhub.contract.relay.getData(1, 1, 1, 1, 1, 1, 1, 1);
        let transaction = new ethJsTx({
            nonce: 2,
            gasPrice: 2,
            gasLimit: 200000,
            to: sr.address,
            value: 0,
            data: data1
        })
        let privKey = Buffer.from("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d", "hex");
        transaction.sign(privKey)
        let rawTx = "0x" + transaction.serialize().toString('hex')
        console.log("tx to audit", rawTx)
        await tbk.auditTransaction(rawTx, [localhostOne, localhostOne]);
    });

    it.skip("should report a suspicious transaction to an auditor relay, which will penalize the double-signing relay", async function () {
        /******/
        await postRelayHubAddress(rhub.address, localhostOne);
        await register_new_relay(rhub, 1000, 20, 30, "https://abcd.com", accounts[5]);
        /******/

        // let auditor_relay = accounts[10]
        // let initial_auditor_balance = web3.eth.getBalance(auditor_relay);

        let perpetrator_relay = accounts[5]
        // let perpetrator_stake = await rhub.stakes(perpetrator_relay);

        let perpetrator_priv_key = Buffer.from("395df67f0c2d2d9fe1ad08d1bc8b6627011959b79c53d7dd6a3536a33ab8a4fd", "hex");
        // getTransactionCount is, by definition, account's nonce+1
        let reused_nonce = web3.eth.getTransactionCount(perpetrator_relay)

        // Make sure the transaction with that nonce was mined
        let result = await sr.emitMessage("hello world", { from: perpetrator_relay })
        var log = result.logs[0];
        assert.equal("SampleRecipientEmitted", log.event);

        // Create another tx with the same nonce
        let data2 = rhub.contract.relay.getData(1, 1, 1, 1, 1, 1, 1, 1);
        let transaction2 = new ethJsTx({
            nonce: reused_nonce - 1,
            gasPrice: 2,
            gasLimit: 200000,
            to: sr.address,
            value: 0,
            data: data2
        })
        transaction2.sign(perpetrator_priv_key)
        let rawTx = "0x" + transaction2.serialize().toString('hex')

        let tbk = new RelayClient(web3, { relayUrl: localhostOne });
        await tbk.auditTransaction(rawTx, [localhostOne]);
        // let the auditor do the job
        // testutils.sleep(10)


        let perpetrator_new_stake = await rhub.stakes(perpetrator_relay);

        assert.equal(0, perpetrator_new_stake[0].toNumber())
        // TODO: validate reward distributed fairly

    });

    function timeout(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    it("should fallback to other relays if the preferred one does not respond correctly", async function () {
        let rc = new RelayClient(web3)
        let orig_httpSend = rc.httpSend
        let httpSend = {
            send: function (url, jsonRequestData, callback) {
                if (!url.includes("relay")) {
                    orig_httpSend(url, jsonRequestData, callback)
                    return
                }
                if (counter == 0) {
                    counter++
                    setTimeout(callback(new Error("Test error"), null), 100)
                }
                else if (counter == 1) {
                    counter++
                    setTimeout(callback(null, JSON.stringify({})), 100)
                }
                else {
                    let callback_wrap = function (e, r) {
                        assert.equal(null, e)
                        assert.equal(true, r.input.includes(message_hex))
                        callback(e, r)
                    }
                    orig_httpSend.send(url, jsonRequestData, callback_wrap)
                }
            }
        }
        let mockServerHelper = {
            getRelaysAdded: async function () {
                await timeout(200)
                return filteredRelays
            },
            newActiveRelayPinger: function () {
                return {
                    nextRelay: async function () {
                        await timeout(200)
                        return filteredRelays[counter]
                    },
                }
            },
            setHub: function(){}
        }
        let tbk = new RelayClient(web3, { serverHelper: mockServerHelper });
        tbk.httpSend = httpSend
        let filteredRelays = [
            { relayUrl: "localhost1", RelayServerAddress: accounts[10] },
            { relayUrl: "localhost2", RelayServerAddress: accounts[10] },
            { relayUrl: localhostOne, RelayServerAddress: accounts[10] }
        ]

        var counter = 0

        let message = "hello world"
        let message_hex = "0b68656c6c6f20776f726c64"
        let encoded = sr.contract.emitMessage.getData(message)

        let options = {
            from: gasLess,
            to: sr.address,
            txfee: 12,
            gas_price: 3,
            gas_limit: 1000000
        }

        let validTransaction = await tbk.relayTransaction(encoded, options);

        // RelayClient did retry for 2 times
        assert.equal(2, counter)

        // The transaction was checked by internal logic of RelayClient (tested elsewhere) and deemed valid
        assert.equal(32, validTransaction.hash(false).length)

    })
});
