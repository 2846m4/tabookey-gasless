const RelayServer = require('./relayserver')

const options = {
    "HttpsCert" :{  //this is the only "new" option, not originated from go server..
        help: "PEM file of key and certifcates for an https server",
        def : "server.pem"
    },
    "SleepTime": { help:"sleep time between checks. 0 to disable background sleep (and check on each http call)"},
    "EthereumNodeUrl" :{
        help:"The relay's ethereum node",
        def:"http://localhost:8545"
    } ,
    "LookupLimitBlocks" : {
        help:"How many blacks back to look for RelayAdded",
        def: 5900,
    },
    "DefaultGasPrice": {
        help:"Relay's default gasPrice per (non-relayed) transaction in wei",
        def: 1e9    //1gwei
    },
    "Fee": {
        help: "Relay's per transaction fee",
        def: 11
    },
    "GasLimit": {
        help: "Relay's gas limit per transaction",
        def: 100000
    },
    "GasPricePercent": {
        help: "Relay's gas price increase as percentage from current average. GasPrice = (100+GasPricePercent)/100 * eth_gasPrice()",
        def: 10
    },
    "Port": {
        help: "Relay server's port"
    },
    "RelayHubAddress": {
        help: "RelayHub address",
        def: "0x254dffcd3277c0b1660f6d42efbb754edababc2b"
    },
    "ShortSleep": {
        help: "Whether we wait after calls to blockchain or return (almost) immediately",
        val: true
    },
    "Url": {
        help: "Relay server's url",
        def: "http://localhost:8090"
    },
    "Workdir": {
        help: "The relay server's workdir",
        def: "./build/server"
    },
    "Verbose": {
        help: "Verbose logging",
        val: true
    }
}

function usage(msg) {
    msg && console.error(msg);
    console.error("Usage: ")
    for (let name in options) {
        let opt = options[name]
        console.log("  " + name)
        console.log("\t" + opt.help, opt.def ? "(default " + opt.def + ")" : "")
    }
    process.exit(1)
}

function parse(args) {
    let ret = {}
    args = Array.prototype.slice.call(args)
    if (args.length < 2)
        usage()
    for (let i = 2; i < args.length; i++) {
        let optname = args[i].replace(/^-/, "")
        let opt = options[optname];
        if (!opt) usage("Unknown option: -" + optname)
        let val = opt.val || args[++i];
        ret[optname] = val
    }
    for (let optname in options) {
        if (!ret[optname])
            ret[optname] = options[optname].def
    }

    return ret
}

async function RunRelay(args) {
    let opts = parse(args)
    new RelayServer(opts)
}

module.exports=RunRelay
