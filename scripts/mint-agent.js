#!/usr/bin/env node
/**
 * scripts/mint-agent.js — host-side helper for the Binance Agentic Wallet (BAW) path.
 *
 * Solves the on-chain proof-of-work challenge for a wallet address, encodes the
 * mint() calldata, and prints the exact `baw contract-call preview` /
 * `baw contract-call execute` commands to run.
 *
 * It never signs and never sends anything itself: BAW holds the key.
 *
 * Usage:
 *   node scripts/mint-agent.js <walletAddress> [--chain 56|97] [--rpc <url>]
 *   WALLET_ADDRESS=0x... node scripts/mint-agent.js
 */
const { ethers } = require("ethers");
const { keccak_256 } = require("@noble/hashes/sha3");
const fs = require("fs");
const path = require("path");

const MINT_FEE_WEI = 80000000000000n; // 0.00008 BNB
const NFT_ABI = [
  "function difficultyBits() view returns (uint256)",
  "function mintedBy(address) view returns (uint256)",
  "function maxPerWallet() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function powValid(address minter, uint256 nonce, uint256 bits) pure returns (bool)",
  "function mint(uint256 nonce) payable",
];

const CHAINS = {
  56: {
    name: "BNB Smart Chain",
    rpc: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    explorer: "https://bscscan.com",
  },
  97: {
    name: "BNB Smart Chain Testnet",
    rpc:
      process.env.BSC_TESTNET_RPC_URL ||
      "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    explorer: "https://testnet.bscscan.com",
  },
  // Local development only: lets you dry-run this helper against `hardhat node`.
  31337: {
    name: "Hardhat Local",
    rpc: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
    explorer: "",
  },
};

function parseArgs(argv) {
  const out = { wallet: null, chain: null, rpc: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") out.chain = Number(argv[++i]);
    else if (a === "--rpc") out.rpc = argv[++i];
    else if (!a.startsWith("--") && !out.wallet) out.wallet = a;
  }
  return out;
}

function loadConfig() {
  const p = path.join(__dirname, "..", "web", "config.js");
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const m = raw.match(/window\.RETRIAL_CONFIG\s*=\s*(\{[\s\S]*?\});/);
    return m ? JSON.parse(m[1]) : {};
  } catch {
    return {};
  }
}

/**
 * Find a nonce such that keccak256(abi.encodePacked(wallet, nonce)) has at
 * least `bits` leading zero bits — byte-for-byte the contract's powValid.
 *
 * Uses @noble/hashes over the exact 52-byte preimage (address(20) ‖ uint256(32),
 * nonce big-endian in the trailing 4 bytes) because it is ~3x faster than
 * ethers' packed hasher, and checks the winner against the ethers expression so
 * an encoding mistake cannot pass silently.
 */
function solvePoW(wallet, bits) {
  const target = 1n << BigInt(256 - bits);
  const buf = new Uint8Array(52);
  buf.set(ethers.getBytes(wallet), 0);
  const view = new DataView(buf.buffer);
  const started = Date.now();

  for (let n = 0; n <= 0xffffffff; n++) {
    view.setUint32(48, n, false);
    const h = keccak_256(buf);
    if (
      (bits >= 8 && h[0] !== 0) ||
      (bits >= 16 && h[1] !== 0) ||
      (bits >= 20 && (h[2] & 0xf0) !== 0)
    ) {
      continue;
    }
    const hashHex = "0x" + Buffer.from(h).toString("hex");
    if (BigInt(hashHex) < target) {
      const reference = ethers.solidityPackedKeccak256(
        ["address", "uint256"],
        [wallet, BigInt(n)]
      );
      if (reference !== hashHex) {
        throw new Error(
          `packing mismatch: noble ${hashHex} vs ethers ${reference} for nonce ${n}`
        );
      }
      const secs = (Date.now() - started) / 1000;
      return { nonce: BigInt(n), hash: hashHex, tries: BigInt(n + 1), secs };
    }
  }
  throw new Error("no nonce found in the 2^32 search space");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  const wallet =
    args.wallet ||
    process.env.WALLET_ADDRESS ||
    process.env.AGENT_WALLET ||
    null;
  if (!wallet || !ethers.isAddress(wallet)) {
    console.error(
      "Need a wallet address: `node scripts/mint-agent.js 0xYourBawWallet` or WALLET_ADDRESS=0x..."
    );
    process.exit(1);
  }

  const chainId = args.chain || Number(cfg.chainId) || 97;
  const chain = CHAINS[chainId];
  if (!chain) {
    console.error(
      `Unsupported chain ${chainId}. Use --chain 56 (mainnet) or --chain 97 (testnet).`
    );
    process.exit(1);
  }
  const rpc = args.rpc || cfg.rpcUrl || chain.rpc;
  const nftAddress = process.env.NFT_ADDRESS || cfg.nftAddress;
  if (!nftAddress || !ethers.isAddress(nftAddress)) {
    console.error(
      "No NFT address. Deploy first (scripts/deploy.js writes web/config.js) or set NFT_ADDRESS=0x..."
    );
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpc, chainId, {
    staticNetwork: true,
  });
  const nft = new ethers.Contract(nftAddress, NFT_ABI, provider);

  console.log(`chain          : ${chain.name} (${chainId})`);
  console.log(`rpc            : ${rpc}`);
  console.log(`nft contract   : ${nftAddress}`);
  console.log(`minter wallet  : ${wallet}`);

  const [bits, minted, cap, maxSupply, totalMinted] = await Promise.all([
    nft.difficultyBits(),
    nft.mintedBy(wallet),
    nft.maxPerWallet(),
    nft.MAX_SUPPLY(),
    nft.totalMinted(),
  ]);

  console.log(
    `state          : minted ${totalMinted}/${maxSupply} · this wallet ${minted}/${cap} · difficulty ${bits} bits`
  );
  if (minted >= cap) {
    console.error("This wallet already reached maxPerWallet — nothing to mint.");
    process.exit(1);
  }
  if (totalMinted >= maxSupply) {
    console.error("Collection is sold out — nothing to mint.");
    process.exit(1);
  }

  console.log(`\nSolving ${bits}-bit proof of work...`);
  const { nonce, hash, tries, secs } = solvePoW(wallet, Number(bits));
  console.log(
    `solved         : nonce ${nonce} after ${tries} hashes in ${secs.toFixed(1)}s`
  );
  console.log(`hash           : ${hash}`);

  // Grade the nonce with the contract's own view before proposing anything.
  const ok = await nft.powValid(wallet, nonce, bits);
  console.log(`powValid()     : ${ok}`);
  if (!ok) {
    console.error("Contract rejected the nonce — aborting.");
    process.exit(1);
  }

  const iface = new ethers.Interface(NFT_ABI);
  const inputData = iface.encodeFunctionData("mint", [nonce]);

  console.log("\n--- Binance Agentic Wallet (BAW) ---");
  console.log("Developer Mode must be on (baw wallet settings --json → devMode.enabled).\n");
  console.log("1) preview:");
  console.log(
    `baw contract-call preview --binanceChainId ${chainId} --from ${wallet} --to ${nftAddress} --value ${MINT_FEE_WEI} --inputData ${inputData} --json`
  );
  console.log("\n2) after reading the preview and confirming it:");
  console.log(`baw contract-call execute --requestId <requestId from preview> --json`);
  console.log(
    `\nExplorer       : ${chain.explorer}/address/${nftAddress}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
