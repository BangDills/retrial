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

describe("RetrialMarket", () => {
  let nft;
  let market;
  let owner;
  let seller;
  let buyer;
  let other;
  const MINT_FEE = ethers.parseEther("0.00008");
  const LIST_PRICE = ethers.parseEther("0.5");

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    owner = signers[0];
    seller = signers[1];
    buyer = signers[2];
    other = signers[3];

    // Deploy NFT
    const NFTFactory = await ethers.getContractFactory("RetrialNFT");
    nft = await NFTFactory.deploy(3000);
    await nft.waitForDeployment();

    // Deploy Market
    const MarketFactory = await ethers.getContractFactory("RetrialMarket");
    market = await MarketFactory.deploy(await nft.getAddress());
    await market.waitForDeployment();

    // Set difficulty to 8 bits for instant minting in tests
    await nft.connect(owner).setDifficultyBits(8);

    // Mint token 1 to seller
    const r1 = solvePoW(seller.address, 8, 0n);
    await nft.connect(seller).mint(r1.nonce, { value: MINT_FEE });

    // Mint token 2 to seller
    const r2 = solvePoW(seller.address, 8, r1.nonce + 1n);
    await nft.connect(seller).mint(r2.nonce, { value: MINT_FEE });
  });

  // Test 10
  it("10. list requires ownership and price > 0; escrows the NFT", async () => {
    const marketAddress = await market.getAddress();

    // Non-owner cannot list
    await expect(
      market.connect(buyer).list(1n, LIST_PRICE)
    ).to.be.revertedWith("Not token owner");

    // Price must be > 0
    await expect(
      market.connect(seller).list(1n, 0n)
    ).to.be.revertedWith("Price must be > 0");

    // Seller must approve the market before listing.
    // OZ ERC721 reverts with ERC721InsufficientApproval(operator, tokenId).
    await expect(
      market.connect(seller).list(1n, LIST_PRICE)
    ).to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval");

    // Approve and list
    await nft.connect(seller).approve(marketAddress, 1n);
    await expect(market.connect(seller).list(1n, LIST_PRICE))
      .to.emit(market, "Listed")
      .withArgs(seller.address, 1n, LIST_PRICE);

    // NFT is escrowed into market contract
    expect(await nft.ownerOf(1n)).to.equal(marketAddress);

    // Listing recorded
    const listing = await market.listings(1n);
    expect(listing.seller).to.equal(seller.address);
    expect(listing.price).to.equal(LIST_PRICE);
  });

  // Test 11
  it("11. buy with the exact price transfers the NFT and pays the seller; wrong value reverts", async () => {
    const marketAddress = await market.getAddress();
    await nft.connect(seller).approve(marketAddress, 1n);
    await market.connect(seller).list(1n, LIST_PRICE);

    // Wrong values revert
    await expect(
      market.connect(buyer).buy(1n, { value: 0n })
    ).to.be.revertedWith("Incorrect price");

    await expect(
      market.connect(buyer).buy(1n, { value: LIST_PRICE - 1n })
    ).to.be.revertedWith("Incorrect price");

    await expect(
      market.connect(buyer).buy(1n, { value: LIST_PRICE + 1n })
    ).to.be.revertedWith("Incorrect price");

    // Buy with exact price
    const sellerBalBefore = await ethers.provider.getBalance(seller.address);

    await expect(market.connect(buyer).buy(1n, { value: LIST_PRICE }))
      .to.emit(market, "Sold")
      .withArgs(seller.address, buyer.address, 1n, LIST_PRICE);

    const sellerBalAfter = await ethers.provider.getBalance(seller.address);

    // Seller paid (default feeBps = 0)
    expect(sellerBalAfter - sellerBalBefore).to.equal(LIST_PRICE);

    // NFT transferred to buyer
    expect(await nft.ownerOf(1n)).to.equal(buyer.address);

    // Listing cleared
    const listing = await market.listings(1n);
    expect(listing.seller).to.equal(ethers.ZeroAddress);
    expect(listing.price).to.equal(0n);
  });

  // Test 12
  it("12. cancel returns the NFT; non-seller cannot cancel or updatePrice", async () => {
    const marketAddress = await market.getAddress();
    await nft.connect(seller).approve(marketAddress, 2n);
    await market.connect(seller).list(2n, LIST_PRICE);

    const newPrice = ethers.parseEther("0.8");

    // Non-seller cannot updatePrice
    await expect(
      market.connect(other).updatePrice(2n, newPrice)
    ).to.be.revertedWith("Not seller");

    // Non-seller cannot cancel
    await expect(
      market.connect(other).cancel(2n)
    ).to.be.revertedWith("Not seller");

    // Seller updates price
    await expect(market.connect(seller).updatePrice(2n, newPrice))
      .to.emit(market, "PriceUpdated")
      .withArgs(seller.address, 2n, newPrice);

    let listing = await market.listings(2n);
    expect(listing.price).to.equal(newPrice);

    // Seller cancels listing
    await expect(market.connect(seller).cancel(2n))
      .to.emit(market, "Cancelled")
      .withArgs(seller.address, 2n);

    // NFT returned to seller
    expect(await nft.ownerOf(2n)).to.equal(seller.address);

    // Listing cleared
    listing = await market.listings(2n);
    expect(listing.seller).to.equal(ethers.ZeroAddress);
    expect(listing.price).to.equal(0n);
  });

  // Test 13
  it("13. buying a non-listed token reverts", async () => {
    // Unlisted token 999
    await expect(
      market.connect(buyer).buy(999n, { value: LIST_PRICE })
    ).to.be.revertedWith("Not listed");

    // Token 1 exists but is not listed
    await expect(
      market.connect(buyer).buy(1n, { value: LIST_PRICE })
    ).to.be.revertedWith("Not listed");
  });

  // Test 14
  it("14. activeListings() reflects list/cancel/buy", async () => {
    const marketAddress = await market.getAddress();

    // Initially empty
    let [ids, data] = await market.activeListings();
    expect(ids.length).to.equal(0);
    expect(data.length).to.equal(0);

    // List token 1
    await nft.connect(seller).approve(marketAddress, 1n);
    await market.connect(seller).list(1n, LIST_PRICE);

    // List token 2
    const price2 = ethers.parseEther("1.2");
    await nft.connect(seller).approve(marketAddress, 2n);
    await market.connect(seller).list(2n, price2);

    [ids, data] = await market.activeListings();
    expect(ids.length).to.equal(2);
    expect(ids[0]).to.equal(1n);
    expect(ids[1]).to.equal(2n);
    expect(data[0].seller).to.equal(seller.address);
    expect(data[0].price).to.equal(LIST_PRICE);
    expect(data[1].seller).to.equal(seller.address);
    expect(data[1].price).to.equal(price2);

    // Cancel token 1
    await market.connect(seller).cancel(1n);

    [ids, data] = await market.activeListings();
    expect(ids.length).to.equal(1);
    expect(ids[0]).to.equal(2n);
    expect(data[0].seller).to.equal(seller.address);
    expect(data[0].price).to.equal(price2);

    // Buy token 2
    await market.connect(buyer).buy(2n, { value: price2 });

    [ids, data] = await market.activeListings();
    expect(ids.length).to.equal(0);
    expect(data.length).to.equal(0);
  });

  // Extra test for fee handling
  it("fee handling: setFeeBps, buy deduction, and withdrawFees", async () => {
    const marketAddress = await market.getAddress();

    // Owner sets fee to 250 bps (2.5%)
    await expect(market.connect(owner).setFeeBps(250))
      .to.emit(market, "FeeBpsUpdated")
      .withArgs(250n);

    expect(await market.feeBps()).to.equal(250n);

    // Max fee is 500 bps
    await expect(
      market.connect(owner).setFeeBps(501)
    ).to.be.revertedWith("Fee exceeds max 500 bps");

    // List and buy token 1
    await nft.connect(seller).approve(marketAddress, 1n);
    await market.connect(seller).list(1n, LIST_PRICE);

    const sellerBalBefore = await ethers.provider.getBalance(seller.address);
    await market.connect(buyer).buy(1n, { value: LIST_PRICE });
    const sellerBalAfter = await ethers.provider.getBalance(seller.address);

    const fee = (LIST_PRICE * 250n) / 10000n;
    const sellerExpected = LIST_PRICE - fee;
    expect(sellerBalAfter - sellerBalBefore).to.equal(sellerExpected);

    // Contract holds the fee
    expect(await ethers.provider.getBalance(marketAddress)).to.equal(fee);

    // Non-owner cannot withdraw fees
    await expect(
      market.connect(other).withdrawFees(other.address)
    ).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");

    // Owner withdraws fees
    const recipientBalBefore = await ethers.provider.getBalance(other.address);
    await market.connect(owner).withdrawFees(other.address);
    const recipientBalAfter = await ethers.provider.getBalance(other.address);
    expect(recipientBalAfter - recipientBalBefore).to.equal(fee);
    expect(await ethers.provider.getBalance(marketAddress)).to.equal(0n);
  });
});
