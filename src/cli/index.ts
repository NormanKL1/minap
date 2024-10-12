/* eslint-disable fp/no-loops, fp/no-mutation, fp/no-mutating-methods, fp/no-let, no-constant-condition */

import {
  estimateGasAndSubmit,
  calcSwapVsMine,
  submitProof,
  MineConfig,
  getProof,
  getOrCreateMiner,
  MineResult,
  fetchBus,
  findValidBus,
  waitUntilNextEpoch,
  MineProgress,
} from "./common";
import { CONFIG } from "./constants";
import { Network, TurbosSdk } from "turbos-clmm-sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { bcs } from "@mysten/sui/bcs";
import { Stats, ElmApp, Balances } from "./ports";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_TYPE_ARG } from "@mysten/sui/utils";
import { MINE, Config } from "./codegen/mineral/mine/structs";
import { Miner } from "./codegen/mineral/miner/structs";

const { Elm } = require("./Main.elm");

const WALLET_KEY = "WALLET";
const MINE_KEY = "MINOOOR";

const RPCS = [
  "https://fullnode.mainnet.sui.io:443",
  "https://mainnet.suiet.app",
  "https://sui-mainnet-us-1.cosmostation.io",
  "https://sui-mainnet.public.blastapi.io",
  "https://sui-mainnet-eu-3.cosmostation.io",
  "https://sui1mainnet-rpc.chainode.tech",
  "https://mainnet.sui.rpcpool.com",
  "https://sui-mainnet-ca-2.cosmostation.io",
];

const RPC = RPCS[Math.floor(Math.random() * RPCS.length)];

const provider = new SuiClient({
  url: RPC,
});

const turbos = new TurbosSdk(Network.mainnet);

let workers = [];

(async () => {
  let wallet = recoverWallet();
  const app: ElmApp = Elm.Main.init({
    node: document.getElementById("app"),
    flags: {
      rpc: [RPC, RPCS],
      time: Date.now(),
      wallet: wallet
        ? { pub: wallet.toSuiAddress(), pvt: wallet.getSecretKey() }
        : null,
    },
  });

  //// ports registration start

  app.ports.fetchStats.subscribe(() =>
    (async () => {
      const [bus, config] = await Promise.all([
        fetchBus(provider),
        Config.fetch(provider, CONFIG),
      ]);
      const stats: Stats = {
        totalHashes: Number(config.totalHashes),
        totalRewards: Number(config.totalRewards),
        rewardRate: Number(bus.rewardRate),
      };
      app.ports.statsCb.send(stats);
      const rtns = await calcSwapVsMine(turbos, bus.rewardRate);
      app.ports.swapDataCb.send(rtns);
    })().catch((e) => {
      console.error(e);
    })
  );

  app.ports.clearWallet.subscribe(() => {
    wallet = null;
    localStorage.removeItem(WALLET_KEY);
    localStorage.removeItem(MINE_KEY);
  });

  app.ports.registerMiner.subscribe(() =>
    (async () => {
      if (!wallet) {
        return;
      }

      const miner = await getOrCreateMiner(wallet, provider);

      return app.ports.minerCreatedCb.send({
        address: miner.id,
        claims: 0,
      });
    })().catch((e) => {
      console.error(e);
    })
  );

  app.ports.refreshTokens.subscribe(() =>
    (async () => {
      if (!wallet) {
        return app.ports.balancesCb.send(null);
      }
      await updateBalances(app, provider, wallet.toSuiAddress());
    })().catch((e) => {
      console.error(e);
      app.ports.balancesCb.send(null);
    })
  );

  app.ports.combineCoins.subscribe(() =>
    (async () => {
      if (wallet) {
        const coins = await fetchMineral(provider, wallet.toSuiAddress());

        const txb = new Transaction();
        txb.mergeCoins(
          coins[0].coinObjectId,
          coins.slice(1).map((coin) => coin.coinObjectId)
        );
        const _sig = await estimateGasAndSubmit(txb, provider, wallet);
        updateBalances(app, provider, wallet.toSuiAddress());
      }
    })().catch((e) => {
      console.error(e);
      alert(e.message);
    })
  );

  app.ports.importWallet.subscribe((privateKey) =>
    (async () => {
      const kp = privateKey
        ? Ed25519Keypair.fromSecretKey(
            decodeSuiPrivateKey(privateKey).secretKey
          )
        : new Ed25519Keypair();

      localStorage.setItem(WALLET_KEY, kp.getSecretKey());
      wallet = kp;

      const pub = kp.toSuiAddress();
      const miner = await getProof(provider, pub);
      app.ports.walletCb.send({
        address: pub,
        privateKey: kp.getSecretKey(),
        balances: null,
        miningAccount: miner
          ? {
              address: miner.id,
              claims: 0,
            }
          : null,
      });
      await updateBalances(app, provider, pub);
    })().catch((e) => {
      console.error(e);
    })
  );

  app.ports.stopMining.subscribe(() => {
    workers.forEach(worker => worker.terminate());
    workers = [];
  });

  app.ports.copy.subscribe((val) => {
    navigator.clipboard.writeText(val);
  });

  if (wallet) {
    updateBalances(app, provider, wallet.toSuiAddress()).catch(console.error);
  }

  app.ports.submitProof.subscribe((proofData) =>
    (async () => {
      console.log("start submit");
      if (!wallet) {
        return;
      }
      const validBus = await findValidBus(provider);
      if (!validBus) {
        app.ports.statusCb.send(5);
        await waitUntilNextEpoch(provider);
        console.log("retrying");
        return app.ports.retrySubmitProof.send(proofData);
      }

      console.log("submitting transaction...");
      app.ports.statusCb.send(3);
      const res = await submitProof(wallet, provider, proofData, validBus);

      console.log("Mining success!", res.digest);
      app.ports.statusCb.send(4);

      updateBalances(app, provider, wallet.toSuiAddress()).catch(console.error);
    })().catch((e) => {
      console.error(e);
      app.ports.proofSubmitError.send(String(e));
    })
  );

  app.ports.mine.subscribe((miningAccount) =>
    (async () => {
      if (!wallet) {
        return;
      }
      const bus = await fetchBus(provider);

      const workerCount = navigator.hardwareConcurrency || 4;
      for (let i = 0; i < workerCount; i++) {
        const worker = new Worker("/worker.js", { type: "module" });

        worker.onmessage = (e) => handleWorkerMessage(e, app);
        worker.onerror = (e) => {
          console.error(e);
          app.ports.miningError.send("Worker error");
        };

        const startNonce = i * Math.floor(Number.MAX_SAFE_INTEGER / workerCount);
        const mineConfig = await buildMiningConfig(
          wallet.toSuiAddress(),
          miningAccount,
          bus.difficulty,
          startNonce
        );
        worker.postMessage(mineConfig);
        workers.push(worker);
      }
    })().catch((e) => {
      console.error(e);
    })
  );

  //// ports registration end
})().catch(console.error);

async function fetchBalances(client, address) {
  const [mineralObjs, suiBalance] = await Promise.all([
    client.getCoins({ coinType: MINE.$typeName, owner: address }),
    client.getBalance({ owner: address, coinType: SUI_TYPE_ARG }),
  ]);

  mineralObjs.data.sort((a, b) => Number(b.balance) - Number(a.balance));
  const largestBalance = mineralObjs.data[0];

  const mineralBalance = mineralObjs.data.reduce(
    (acc, obj) => acc + BigInt(obj.balance),
    BigInt(0)
  );

  return {
    coinObject: largestBalance ? largestBalance.coinObjectId : null,
    mineralObjects: mineralObjs.data.length,
    mineral: Number(mineralBalance),
    sui: Number(suiBalance.totalBalance),
  };
}

async function updateBalances(app, client, address) {
  const balances = await fetchBalances(client, address);
  app.ports.balancesCb.send(balances);
}

async function buildMiningConfig(addr, miningAccount, difficulty, startNonce) {
  const miner = await Miner.fetch(provider, miningAccount);
  const progress = recoverMiningProgress();
  const initialNonce = progress ? progress.nonce : BigInt(startNonce);
  console.log("Starting nonce:", initialNonce.toString());
  return {
    currentHash: new Uint8Array(miner.currentHash),
    signer: bcs.Address.serialize(addr),
    difficulty: Number(difficulty),
    initialNonce,
  };
}

function handleWorkerMessage(e, app) {
  const { proof } = e.data;
  if (proof) {
    workers.forEach(worker => worker.terminate());
    workers = [];
    app.ports.proofFound.send(proof);
  }
}

function recoverWallet() {
  const key = localStorage.getItem(WALLET_KEY);
  return key ? Ed25519Keypair.fromSecretKey(key) : null;
}

function recoverMiningProgress() {
  const storedProgress = localStorage.getItem(MINE_KEY);
  return storedProgress ? JSON.parse(storedProgress) : null;
}
