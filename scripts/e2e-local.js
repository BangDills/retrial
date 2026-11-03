#!/usr/bin/env node
/**
 * scripts/e2e-local.js — end-to-end proof on a real chain.
 *
 * Run against a live node:
 *   npx hardhat node                                    (terminal 1)
 *   npx hardhat run scripts/e2e-local.js --network localhost
 *
 * It exercises the whole product on chain, with real transactions and real
 * receipts: solve the proof-of-work challenge, mint with the exact fee, list
 * on the marketplace, buy, and read the resulting state back.
 */
const hre = require("hardhat");
const { ethers } = hre;
const { keccak_256 } = require("@noble/hashes/sha3");

const MINT_FEE = ethers.parseEther("0.00008");
const DIFFICULTY_FOR_E2E = 18; // ~2^18 hashes: real work, a few seconds

/**
 * Solve the challenge with a fast hasher over the exact 52-byte preimage the
 * contract hashes: abi.encodePacked(address(20), uint256(32)). The nonce lives
 * big-endian in the last 4 bytes of that buffer.
 *
 * The result is checked against ethers.solidityPackedKeccak256 (the expression
 * the contract's powValid mirrors) before it is used, so a packing mistake can
 * never pass silently.
 */
function solvePoW(address, bits) {
  const target = 1n << BigInt(256 - bits);
  const buf = new Uint8Array(52);
  buf.set(ethers.getBytes(address), 0);
  const view = new DataView(buf.buffer);
  const t0 = Date.now();

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
    const hash = "0x" + Buffer.from(h).toString("hex");
    if (BigInt(hash) < target) {
      const reference = ethers.solidityPackedKeccak256(
        ["address", "uint256"],
        [address, BigInt(n)]
      );
      if (reference !== hash) {
        throw new Error(
          `packing mismatch: noble ${hash} vs ethers ${reference} for nonce ${n}`
        );
      }
      return { nonce: BigInt(n), hash, tries: BigInt(n + 1), ms: Date.now() - t0 };
    }
  }
  throw new Error("no nonce found in the 2^32 search space");
}

const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, minter, buyer] = signers;
  const net = await ethers.provider.getNetwork();
  console.log(`network ${net.name} chainId=${net.chainId} block=${await ethers.provider.getBlockNumber()}`);

  // ---------------------------------------------------------------- deploy
  const NFT = await ethers.getContractFactory("RetrialNFT");
  const nft = await NFT.deploy(3000);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();

  const Market = await ethers.getContractFactory("RetrialMarket");
  const market = await Market.deploy(nftAddr);
  await market.waitForDeployment();
  const marketAddr = await market.getAddress();

  const nftDeploy = await ethers.provider.getTransactionReceipt(
    nft.deploymentTransaction().hash
  );
  const marketDeploy = await ethers.provider.getTransactionReceipt(
    market.deploymentTransaction().hash
  );
  console.log(`RetrialNFT    ${nftAddr}  gas ${nftDeploy.gasUsed}`);
  console.log(`RetrialMarket ${marketAddr}  gas ${marketDeploy.gasUsed}`);

  console.log("\n[1] challenge solver");
  await (await nft.setDifficultyBits(DIFFICULTY_FOR_E2E)).wait();
  const bits = await nft.difficultyBits();
  const solved = solvePoW(minter.address, Number(bits));
  console.log(
    `  difficulty ${bits} bits · nonce ${solved.nonce} · ${solved.tries} hashes · ${solved.ms}ms`
  );
  ok("contract agrees the nonce is valid", await nft.powValid(minter.address, solved.nonce, bits));

  console.log("\n[2] mint with the exact fee");
  const balBefore = await ethers.provider.getBalance(nftAddr);
  const mintTx = await nft.connect(minter).mint(solved.nonce, { value: MINT_FEE });
  const mintRc = await mintTx.wait();
  const balAfter = await ethers.provider.getBalance(nftAddr);

  const transfer = mintRc.logs
    .map((l) => {
      try {
        return nft.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "Transfer");
  const tokenId = transfer.args.tokenId;
  const gasPrice = mintRc.gasPrice ?? (await ethers.provider.getFeeData()).gasPrice;
  const gasCost = mintRc.gasUsed * gasPrice;

  console.log(`  tx ${mintRc.hash}`);
  console.log(`  tokenId ${tokenId} · gasUsed ${mintRc.gasUsed} · gasPrice ${gasPrice} wei`);
  console.log(`  gas cost ${ethers.formatEther(gasCost)} BNB · mint fee ${ethers.formatEther(MINT_FEE)} BNB`);
  console.log(
    `  total cost to minter ${ethers.formatEther(gasCost + MINT_FEE)} BNB`
  );
  ok("minted exactly one token to the minter", (await nft.ownerOf(tokenId)) === minter.address);
  ok("fee collected by the contract", balAfter - balBefore === MINT_FEE);
  ok("totalMinted == 1", (await nft.totalMinted()) === 1n);
  ok("mintedBy(minter) == 1", (await nft.mintedBy(minter.address)) === 1n);

  console.log("\n[3] on-chain metadata");
  const uri = await nft.tokenURI(tokenId);
  const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
  const svg = Buffer.from(json.image.split(",")[1], "base64").toString();
  console.log(`  name: ${json.name}`);
  console.log(`  image: ${svg.length} bytes of SVG, contains "#${tokenId}": ${svg.includes(`#${tokenId}`)}`);
  ok("tokenURI is a data URI", uri.startsWith("data:application/json;base64,"));

  console.log("\n[4] marketplace");
  await (await nft.connect(minter).approve(marketAddr, tokenId)).wait();
  const listTx = await market.connect(minter).list(tokenId, ethers.parseEther("0.01"));
  const listRc = await listTx.wait();
  ok("NFT escrowed into the market", (await nft.ownerOf(tokenId)) === marketAddr);
  console.log(`  listed tx ${listRc.hash} gas ${listRc.gasUsed}`);

  const [ids] = await market.activeListings();
  ok("activeListings() shows the listing", ids.length === 1 && ids[0] === tokenId);

  const sellerBefore = await ethers.provider.getBalance(minter.address);
  const buyTx = await market.connect(buyer).buy(tokenId, { value: ethers.parseEther("0.01") });
  const buyRc = await buyTx.wait();
  const sellerAfter = await ethers.provider.getBalance(minter.address);
  console.log(`  bought tx ${buyRc.hash} gas ${buyRc.gasUsed}`);
  ok("buyer now owns the NFT", (await nft.ownerOf(tokenId)) === buyer.address);
  ok("seller received the full price", sellerAfter - sellerBefore === ethers.parseEther("0.01"));
  const [idsAfter] = await market.activeListings();
  ok("listing cleared after the sale", idsAfter.length === 0);

  console.log("\n[5] the gate actually gates");
  const bad = solvePoW(buyer.address, Number(bits));
  await (await nft.connect(buyer).mint(bad.nonce, { value: MINT_FEE })).wait();
  let reverted = false;
  try {
    await nft.connect(buyer).mint(bad.nonce, { value: MINT_FEE });
  } catch (e) {
    reverted = /Nonce already used/.test(e.message);
  }
  ok("replaying a used nonce reverts", reverted);

  let feeReverted = false;
  try {
    const fresh = solvePoW(deployer.address, Number(bits));
    await nft.connect(deployer).mint(fresh.nonce, { value: 0n });
  } catch (e) {
    feeReverted = /Incorrect mint fee/.test(e.message);
  }
  ok("minting without the 0.00008 BNB fee reverts", feeReverted);

  console.log(
    `\n${process.exitCode ? "E2E FAILED" : "E2E OK"} — explorer-less local chain, all state read back from receipts.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
