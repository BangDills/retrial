const { expect } = require("chai");
const { ethers } = require("hardhat");

function solvePoW(address, bits, startNonce = 0n) {
  const target = 1n << BigInt(256 - Number(bits));
  let nonce = BigInt(startNonce);
  while (true) {
    const hash = ethers.solidityPackedKeccak256(["address", "uint256"], [address, nonce]);
    if (BigInt(hash) < target) {
      return { nonce, hash };
    }
    nonce++;
  }
}

describe("RetrialNFT", () => {
  let nft;
  let owner;
  let minter;
  let other;
  const MINT_FEE = ethers.parseEther("0.00008"); // 80_000_000_000_000 wei

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    owner = signers[0];
    // Use signers[3] as minter because it has a fast valid nonce for 20 difficulty bits (~11.7k iterations)
    minter = signers[3];
    other = signers[4];

    const Factory = await ethers.getContractFactory("RetrialNFT");
    nft = await Factory.deploy(3000);
    await nft.waitForDeployment();
  });

  // Test 1
  it("1. metadata: name/symbol/MAX_SUPPLY/MINT_FEE/maxPerWallet/difficultyBits defaults", async () => {
    expect(await nft.name()).to.equal("Retrial");
    expect(await nft.symbol()).to.equal("RTR");
    expect(await nft.MAX_SUPPLY()).to.equal(3000n);
    expect(await nft.MINT_FEE()).to.equal(MINT_FEE);
    expect(await nft.maxPerWallet()).to.equal(5n);
    expect(await nft.difficultyBits()).to.equal(20n);
    expect(await nft.totalMinted()).to.equal(0n);
    expect(await nft.mintedCount()).to.equal(0n);
    expect(await nft.remaining()).to.equal(3000n);
  });

  // Test 2
  it("2. a JS solver finds a valid nonce for difficultyBits and mint succeeds with value = MINT_FEE; tokenId == 1; owner is the minter; mintedBy == 1; event emitted", async () => {
    const bits = await nft.difficultyBits();
    const { nonce } = solvePoW(minter.address, bits);

    // Verify powValid confirms the nonce
    expect(await nft.powValid(minter.address, nonce, bits)).to.be.true;

    await expect(nft.connect(minter).mint(nonce, { value: MINT_FEE }))
      .to.emit(nft, "Minted")
      .withArgs(minter.address, 1n, nonce, bits);

    expect(await nft.totalMinted()).to.equal(1n);
    expect(await nft.mintedCount()).to.equal(1n);
    expect(await nft.remaining()).to.equal(2999n);
    expect(await nft.ownerOf(1n)).to.equal(minter.address);
    expect(await nft.mintedBy(minter.address)).to.equal(1n);
  });

  // Test 3
  it("3. mint with wrong value (0 and MINT_FEE-1) reverts", async () => {
    const bits = await nft.difficultyBits();
    const { nonce } = solvePoW(minter.address, bits);

    await expect(
      nft.connect(minter).mint(nonce, { value: 0n })
    ).to.be.revertedWith("Incorrect mint fee");

    await expect(
      nft.connect(minter).mint(nonce, { value: MINT_FEE - 1n })
    ).to.be.revertedWith("Incorrect mint fee");

    await expect(
      nft.connect(minter).mint(nonce, { value: MINT_FEE + 1n })
    ).to.be.revertedWith("Incorrect mint fee");
  });

  // Test 4
  it("4. reusing the same nonce reverts", async () => {
    const bits = await nft.difficultyBits();
    const { nonce } = solvePoW(minter.address, bits);

    await nft.connect(minter).mint(nonce, { value: MINT_FEE });
    expect(await nft.usedNonce(minter.address, nonce)).to.be.true;

    await expect(
      nft.connect(minter).mint(nonce, { value: MINT_FEE })
    ).to.be.revertedWith("Nonce already used");
  });

  // Test 5
  it("5. a nonce that does NOT satisfy the difficulty reverts (use powValid to pick a bad one)", async () => {
    const bits = await nft.difficultyBits();
    let badNonce = 0n;
    while (await nft.powValid(minter.address, badNonce, bits)) {
      badNonce++;
    }
    expect(await nft.powValid(minter.address, badNonce, bits)).to.be.false;

    await expect(
      nft.connect(minter).mint(badNonce, { value: MINT_FEE })
    ).to.be.revertedWith("Invalid proof of work");
  });

  // Test 6
  it("6. per-wallet cap: after maxPerWallet mints the next reverts", async () => {
    // Set difficulty to 8 bits for instant solving
    await nft.connect(owner).setDifficultyBits(8);
    expect(await nft.difficultyBits()).to.equal(8n);

    const cap = Number(await nft.maxPerWallet());
    let currentNonce = 0n;

    for (let i = 0; i < cap; i++) {
      const { nonce } = solvePoW(minter.address, 8, currentNonce);
      await nft.connect(minter).mint(nonce, { value: MINT_FEE });
      currentNonce = nonce + 1n;
    }

    expect(await nft.mintedBy(minter.address)).to.equal(BigInt(cap));

    const { nonce: sixthNonce } = solvePoW(minter.address, 8, currentNonce);
    await expect(
      nft.connect(minter).mint(sixthNonce, { value: MINT_FEE })
    ).to.be.revertedWith("Max per wallet reached");
  });

  // Test 7
  it("7. supply cap: set maxPerWallet high, set difficulty low (e.g. 8) and assert the contract reverts once totalMinted == MAX_SUPPLY", async () => {
    // Deploy contract with small MAX_SUPPLY = 2
    const Factory = await ethers.getContractFactory("RetrialNFT");
    const smallNft = await Factory.deploy(2);
    await smallNft.waitForDeployment();

    expect(await smallNft.MAX_SUPPLY()).to.equal(2n);

    await smallNft.connect(owner).setMaxPerWallet(50);
    await smallNft.connect(owner).setDifficultyBits(8);

    let currentNonce = 0n;

    // Mint token 1
    const res1 = solvePoW(minter.address, 8, currentNonce);
    await smallNft.connect(minter).mint(res1.nonce, { value: MINT_FEE });
    currentNonce = res1.nonce + 1n;

    // Mint token 2
    const res2 = solvePoW(minter.address, 8, currentNonce);
    await smallNft.connect(minter).mint(res2.nonce, { value: MINT_FEE });
    currentNonce = res2.nonce + 1n;

    expect(await smallNft.totalMinted()).to.equal(2n);
    expect(await smallNft.remaining()).to.equal(0n);

    // 3rd mint must revert
    const res3 = solvePoW(minter.address, 8, currentNonce);
    await expect(
      smallNft.connect(minter).mint(res3.nonce, { value: MINT_FEE })
    ).to.be.revertedWith("Max supply reached");
  });

  // Test 8
  it("8. tokenURI returns a data URI that base64-decodes to JSON with an image SVG containing the token id", async () => {
    await nft.connect(owner).setDifficultyBits(8);
    const { nonce } = solvePoW(minter.address, 8);
    await nft.connect(minter).mint(nonce, { value: MINT_FEE });

    const uri = await nft.tokenURI(1n);
    expect(uri).to.match(/^data:application\/json;base64,/);

    const b64Json = uri.replace("data:application/json;base64,", "");
    const jsonStr = Buffer.from(b64Json, "base64").toString("utf-8");
    const json = JSON.parse(jsonStr);

    expect(json.name).to.equal("Retrial #1");
    expect(json.description).to.be.a("string");
    expect(json.image).to.match(/^data:image\/svg\+xml;base64,/);

    const attrMap = {};
    json.attributes.forEach((a) => {
      attrMap[a.trait_type] = a.value;
    });
    expect(attrMap["Challenge bits"]).to.equal(8);
    expect(attrMap["Mint fee"]).to.equal("0.00008 BNB");
    expect(attrMap["Token id"]).to.equal(1);

    const b64Svg = json.image.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(b64Svg, "base64").toString("utf-8");
    expect(svg).to.include("<svg");
    expect(svg).to.include("#1");
  });

  // Test 9
  it("9. withdraw pays the owner and reverts for non-owner", async () => {
    await nft.connect(owner).setDifficultyBits(8);
    const { nonce } = solvePoW(minter.address, 8);
    await nft.connect(minter).mint(nonce, { value: MINT_FEE });

    const contractBal = await ethers.provider.getBalance(await nft.getAddress());
    expect(contractBal).to.equal(MINT_FEE);

    // Non-owner cannot withdraw
    await expect(
      nft.connect(other).withdraw(other.address)
    ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");

    // Owner withdraws
    const recipient = other;
    const balBefore = await ethers.provider.getBalance(recipient.address);
    await nft.connect(owner).withdraw(recipient.address);
    const balAfter = await ethers.provider.getBalance(recipient.address);

    expect(balAfter - balBefore).to.equal(contractBal);
    expect(await ethers.provider.getBalance(await nft.getAddress())).to.equal(0n);
  });
});
