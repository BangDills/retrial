// web/market.js — Retrial NFT Marketplace Logic

// Ensure shared ABI and utilities are available
const shared = window.RetrialShared || {};
const ABI = window.RETRIAL_ABI || {};
const NFT_ABI = ABI.nft || window.RETRIAL_NFT_ABI;
const MARKET_ABI = ABI.market || window.RETRIAL_MARKET_ABI;

let marketUserAccount = null;
let marketUserSigner = null;
let activeListingsData = [];

function showMarketAlert(id, message, type = "info", actionBtn = null) {
  const container = document.getElementById(id);
  if (!container) return;
  container.className = `alert alert-${type}`;
  container.innerHTML = "";

  const content = document.createElement("div");
  content.className = "alert-content";
  content.innerHTML = message;
  container.appendChild(content);

  if (actionBtn) {
    container.appendChild(actionBtn);
  }
  container.classList.remove("hidden");
}

function hideMarketAlert(id) {
  const container = document.getElementById(id);
  if (container) {
    container.classList.add("hidden");
    container.innerHTML = "";
  }
}

async function checkMarketChain() {
  if (!window.ethereum) return true;
  const config = shared.getAppConfig();
  try {
    const hexChainId = await window.ethereum.request({ method: "eth_chainId" });
    const chainId = parseInt(hexChainId, 16);

    const badge = document.getElementById("market-network-badge");
    if (badge) badge.textContent = `Chain: ${chainId}`;

    if (Number(config.chainId) !== chainId) {
      const switchBtn = document.createElement("button");
      switchBtn.className = "btn btn-primary btn-sm";
      switchBtn.textContent = `Switch to ${config.chainName} (${config.chainId})`;
      switchBtn.onclick = async () => {
        try {
          await shared.switchOrAddChain(config.chainId);
          hideMarketAlert("market-chain-alert");
        } catch (e) {
          showMarketAlert("market-chain-alert", `Failed to switch chain: ${e.message || e}`, "error");
        }
      };

      showMarketAlert(
        "market-chain-alert",
        `⚠️ <strong>Wrong Network:</strong> Connected to Chain ID ${chainId}. Expected <strong>${config.chainName} (${config.chainId})</strong>.`,
        "warning",
        switchBtn
      );
      return false;
    } else {
      hideMarketAlert("market-chain-alert");
      return true;
    }
  } catch (err) {
    console.warn("Chain check error:", err);
    return true;
  }
}

async function connectMarketWallet() {
  const connectBtn = document.getElementById("market-connect-wallet-btn");
  hideMarketAlert("market-wallet-alert");

  if (!window.ethereum) {
    showMarketAlert(
      "market-wallet-alert",
      "<strong>No Web3 Wallet Detected:</strong> Please install MetaMask or Binance Web3 Wallet to trade NFTs. (Read-only mode active via RPC).",
      "warning"
    );
    return;
  }

  try {
    if (connectBtn) {
      connectBtn.disabled = true;
      connectBtn.textContent = "Connecting...";
    }

    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await browserProvider.send("eth_requestAccounts", []);
    if (accounts && accounts.length > 0) {
      marketUserAccount = accounts[0];
      marketUserSigner = await browserProvider.getSigner();

      if (connectBtn) {
        connectBtn.textContent = shared.formatAddress(marketUserAccount);
        connectBtn.title = marketUserAccount;
        connectBtn.classList.remove("btn-primary");
        connectBtn.classList.add("btn-secondary");
      }

      await checkMarketChain();
      await loadMarketData();
      await loadMyNFTs();
    }
  } catch (err) {
    console.error("Market wallet connection error:", err);
    if (err.code === 4001 || (err.message && err.message.toLowerCase().includes("rejected"))) {
      showMarketAlert("market-wallet-alert", "Connection request was rejected by user.", "warning");
    } else {
      showMarketAlert("market-wallet-alert", `Connection failed: ${err.message || err}`, "error");
    }
  } finally {
    if (connectBtn) connectBtn.disabled = false;
  }
}

async function loadMarketData() {
  const config = shared.getAppConfig();
  const provider = shared.getReadProvider();
  const grid = document.getElementById("listings-grid");
  const emptyState = document.getElementById("listings-empty");
  const activeCountEl = document.getElementById("stat-active-listings");

  if (!provider) {
    showMarketAlert(
      "market-page-alert",
      `Unable to connect to RPC at <code>${config.rpcUrl}</code>.`,
      "error"
    );
    return;
  }

  try {
    const market = new ethers.Contract(config.marketAddress, MARKET_ABI, provider);
    const nft = new ethers.Contract(config.nftAddress, NFT_ABI, provider);

    // Call activeListings()
    const [ids, data] = await market.activeListings();
    activeListingsData = [];

    if (activeCountEl) {
      activeCountEl.textContent = ids.length.toString();
    }

    if (ids.length === 0) {
      if (grid) grid.innerHTML = "";
      if (emptyState) emptyState.classList.remove("hidden");
      hideMarketAlert("market-page-alert");
      return;
    }

    if (emptyState) emptyState.classList.add("hidden");
    if (grid) grid.innerHTML = "<div class='text-muted' style='grid-column: 1/-1;'>Loading listings...</div>";

    const cardsHtml = [];

    for (let i = 0; i < ids.length; i++) {
      const tokenId = ids[i];
      const listing = data[i];
      const seller = listing.seller;
      const price = listing.price;
      const priceBnb = ethers.formatEther(price);

      activeListingsData.push({
        tokenId: tokenId.toString(),
        seller: seller.toLowerCase(),
        price: price.toString(),
        priceBnb
      });

      let svgHtml = `<div style="padding: 40px; color: var(--text-muted); font-size: 1.5rem;">#${tokenId.toString()}</div>`;
      let tokenName = `Retrial #${tokenId.toString()}`;

      try {
        const tokenUri = await nft.tokenURI(tokenId);
        const metadata = shared.decodeTokenURI(tokenUri);
        if (metadata?.name) tokenName = metadata.name;
        if (metadata?.image) {
          const svgContent = shared.extractSVG(metadata.image);
          if (svgContent) {
            svgHtml = svgContent;
          } else {
            svgHtml = `<img src="${metadata.image}" alt="${tokenName}" />`;
          }
        }
      } catch (uriErr) {
        console.warn(`Failed to fetch metadata for token #${tokenId}:`, uriErr);
      }

      const isOwnListing = marketUserAccount && seller.toLowerCase() === marketUserAccount.toLowerCase();

      let actionButtonHtml = "";
      if (isOwnListing) {
        actionButtonHtml = `
          <div style="display: flex; gap: 8px; width: 100%;">
            <button class="btn btn-secondary btn-sm" style="flex:1" onclick="handleUpdatePrice('${tokenId.toString()}', '${priceBnb}')">Update Price</button>
            <button class="btn btn-danger btn-sm" style="flex:1" onclick="handleCancelListing('${tokenId.toString()}')">Cancel</button>
          </div>
        `;
      } else {
        actionButtonHtml = `
          <button class="btn btn-primary" style="width: 100%" onclick="handleBuyListing('${tokenId.toString()}', '${price.toString()}', '${priceBnb}')">
            Buy for ${priceBnb} BNB
          </button>
        `;
      }

      cardsHtml.push(`
        <div class="nft-card" id="card-${tokenId.toString()}">
          <div class="nft-card-img-wrap">
            ${svgHtml}
          </div>
          <div class="nft-card-body">
            <div class="nft-card-title">${tokenName}</div>
            <div class="nft-card-seller">
              Seller: <span class="font-mono" title="${seller}">${shared.formatAddress(seller)}</span>
              ${isOwnListing ? '<span class="badge" style="color:var(--primary); margin-left:4px;">You</span>' : ''}
            </div>
            <div class="nft-card-price-row">
              <span class="nft-card-price-label">Price</span>
              <span class="nft-card-price-val">${priceBnb} BNB</span>
            </div>
            ${actionButtonHtml}
          </div>
        </div>
      `);
    }

    if (grid) {
      grid.innerHTML = cardsHtml.join("");
    }
    hideMarketAlert("market-page-alert");
  } catch (err) {
    console.error("Failed to load active listings:", err);
    showMarketAlert(
      "market-page-alert",
      `<strong>RPC Error:</strong> Failed to read activeListings() from market contract at <code>${config.marketAddress}</code>. (${err.message || err})`,
      "error"
    );
  }
}

async function handleBuyListing(tokenId, priceWei, priceBnb) {
  if (!marketUserAccount || !marketUserSigner) {
    showMarketAlert("market-action-alert", "Please connect your wallet first to buy this NFT.", "warning");
    connectMarketWallet();
    return;
  }

  hideMarketAlert("market-action-alert");
  const config = shared.getAppConfig();
  const market = new ethers.Contract(config.marketAddress, MARKET_ABI, marketUserSigner);

  try {
    showMarketAlert(
      "market-action-alert",
      `Initiating purchase of Retrial #${tokenId} for ${priceBnb} BNB... Please confirm in your wallet.`,
      "info"
    );

    const tx = await market.buy(tokenId, { value: BigInt(priceWei) });
    showMarketAlert(
      "market-action-alert",
      `Purchase tx submitted: <code>${tx.hash}</code>. Waiting for confirmation...`,
      "info"
    );

    await tx.wait();
    showMarketAlert(
      "market-action-alert",
      `🎉 <strong>Success!</strong> Retrial #${tokenId} bought for ${priceBnb} BNB!`,
      "success"
    );

    await loadMarketData();
    await loadMyNFTs();
  } catch (err) {
    console.error("Buy failed:", err);
    if (err.code === 4001 || (err.message && err.message.toLowerCase().includes("rejected"))) {
      showMarketAlert("market-action-alert", "Purchase was cancelled by user.", "warning");
    } else {
      showMarketAlert("market-action-alert", `Purchase failed: ${err.reason || err.message || err}`, "error");
    }
  }
}

async function handleCancelListing(tokenId) {
  if (!marketUserAccount || !marketUserSigner) {
    showMarketAlert("market-action-alert", "Please connect your wallet first.", "warning");
    connectMarketWallet();
    return;
  }

  hideMarketAlert("market-action-alert");
  const config = shared.getAppConfig();
  const market = new ethers.Contract(config.marketAddress, MARKET_ABI, marketUserSigner);

  try {
    showMarketAlert("market-action-alert", `Cancelling listing for Retrial #${tokenId}... Please confirm.`, "info");
    const tx = await market.cancel(tokenId);
    showMarketAlert("market-action-alert", `Cancel tx submitted: <code>${tx.hash}</code>...`, "info");
    await tx.wait();

    showMarketAlert("market-action-alert", `Listing for Retrial #${tokenId} cancelled and NFT returned to your wallet.`, "success");
    await loadMarketData();
    await loadMyNFTs();
  } catch (err) {
    console.error("Cancel listing error:", err);
    if (err.code === 4001 || (err.message && err.message.toLowerCase().includes("rejected"))) {
      showMarketAlert("market-action-alert", "Cancellation was cancelled by user.", "warning");
    } else {
      showMarketAlert("market-action-alert", `Failed to cancel listing: ${err.reason || err.message || err}`, "error");
    }
  }
}

async function handleUpdatePrice(tokenId, oldPriceBnb) {
  if (!marketUserAccount || !marketUserSigner) {
    showMarketAlert("market-action-alert", "Please connect your wallet first.", "warning");
    connectMarketWallet();
    return;
  }

  const newPriceStr = prompt(`Enter new price in BNB for Retrial #${tokenId}:`, oldPriceBnb);
  if (!newPriceStr) return;

  let newPriceWei;
  try {
    newPriceWei = ethers.parseEther(newPriceStr.trim());
    if (newPriceWei <= 0n) throw new Error("Price must be > 0");
  } catch (e) {
    alert("Invalid price. Please enter a valid number greater than 0.");
    return;
  }

  hideMarketAlert("market-action-alert");
  const config = shared.getAppConfig();
  const market = new ethers.Contract(config.marketAddress, MARKET_ABI, marketUserSigner);

  try {
    showMarketAlert("market-action-alert", `Updating price for Retrial #${tokenId} to ${newPriceStr} BNB...`, "info");
    const tx = await market.updatePrice(tokenId, newPriceWei);
    showMarketAlert("market-action-alert", `Update tx submitted: <code>${tx.hash}</code>...`, "info");
    await tx.wait();

    showMarketAlert("market-action-alert", `Price for Retrial #${tokenId} updated to ${newPriceStr} BNB.`, "success");
    await loadMarketData();
    await loadMyNFTs();
  } catch (err) {
    console.error("Update price error:", err);
    if (err.code === 4001 || (err.message && err.message.toLowerCase().includes("rejected"))) {
      showMarketAlert("market-action-alert", "Update price cancelled by user.", "warning");
    } else {
      showMarketAlert("market-action-alert", `Failed to update price: ${err.reason || err.message || err}`, "error");
    }
  }
}

async function handleApproveAndList(tokenId, inputElementId) {
  if (!marketUserAccount || !marketUserSigner) {
    showMarketAlert("my-nfts-alert", "Please connect your wallet first.", "warning");
    connectMarketWallet();
    return;
  }

  const priceInput = document.getElementById(inputElementId);
  const priceVal = priceInput?.value?.trim();
  if (!priceVal) {
    showMarketAlert("my-nfts-alert", "Please enter a valid listing price in BNB.", "warning");
    return;
  }

  let priceWei;
  try {
    priceWei = ethers.parseEther(priceVal);
    if (priceWei <= 0n) throw new Error("Price must be > 0");
  } catch (e) {
    showMarketAlert("my-nfts-alert", "Invalid price format. Enter a number > 0.", "error");
    return;
  }

  hideMarketAlert("my-nfts-alert");
  const config = shared.getAppConfig();
  const nft = new ethers.Contract(config.nftAddress, NFT_ABI, marketUserSigner);
  const market = new ethers.Contract(config.marketAddress, MARKET_ABI, marketUserSigner);

  try {
    // 1. Check approval
    const approvedAddr = await nft.getApproved(tokenId);
    const isAllApproved = await nft.isApprovedForAll(marketUserAccount, config.marketAddress);

    if (approvedAddr.toLowerCase() !== config.marketAddress.toLowerCase() && !isAllApproved) {
      showMarketAlert("my-nfts-alert", `Step 1/2: Approving RetrialMarket to transfer token #${tokenId}...`, "info");
      const txApprove = await nft.approve(config.marketAddress, tokenId);
      await txApprove.wait();
      showMarketAlert("my-nfts-alert", `Step 1/2: Approval confirmed! Proceeding to listing...`, "info");
    }

    // 2. Call list(tokenId, price)
    showMarketAlert("my-nfts-alert", `Step 2/2: Listing Retrial #${tokenId} for ${priceVal} BNB...`, "info");
    const txList = await market.list(tokenId, priceWei);
    showMarketAlert("my-nfts-alert", `Listing tx submitted: <code>${txList.hash}</code>. Waiting for confirmation...`, "info");
    await txList.wait();

    showMarketAlert("my-nfts-alert", `🎉 Retrial #${tokenId} is now listed for ${priceVal} BNB!`, "success");
    await loadMarketData();
    await loadMyNFTs();
  } catch (err) {
    console.error("Listing error:", err);
    if (err.code === 4001 || (err.message && err.message.toLowerCase().includes("rejected"))) {
      showMarketAlert("my-nfts-alert", "Listing was rejected by user.", "warning");
    } else {
      showMarketAlert("my-nfts-alert", `Listing failed: ${err.reason || err.message || err}`, "error");
    }
  }
}

async function loadMyNFTs() {
  const container = document.getElementById("my-nfts-grid");
  const notConnectedEl = document.getElementById("my-nfts-not-connected");
  const emptyEl = document.getElementById("my-nfts-empty");

  if (!marketUserAccount) {
    if (notConnectedEl) notConnectedEl.classList.remove("hidden");
    if (emptyEl) emptyEl.classList.add("hidden");
    if (container) container.innerHTML = "";
    return;
  }

  if (notConnectedEl) notConnectedEl.classList.add("hidden");
  if (container) container.innerHTML = "<div class='text-muted' style='grid-column: 1/-1;'>Scanning your NFTs...</div>";

  const config = shared.getAppConfig();
  const provider = shared.getReadProvider();
  if (!provider) return;

  const nft = new ethers.Contract(config.nftAddress, NFT_ABI, provider);

  try {
    const totalMinted = await nft.totalMinted();
    const total = Number(totalMinted);
    const ownedTokenIds = [];
    const listedTokenIds = [];

    // Find listed tokens owned by user from active listings data
    activeListingsData.forEach((l) => {
      if (l.seller.toLowerCase() === marketUserAccount.toLowerCase()) {
        listedTokenIds.push(l);
      }
    });

    // Find unlisted tokens owned in wallet
    if (total > 0) {
      // Try event query first
      try {
        const filter = nft.filters.Transfer(null, marketUserAccount);
        const logs = await nft.queryFilter(filter);
        const candidateIds = new Set();
        logs.forEach((log) => {
          try {
            const parsed = nft.interface.parseLog(log);
            if (parsed && parsed.name === "Transfer") {
              candidateIds.add(parsed.args[2].toString());
            }
          } catch (e) {}
        });

        for (const tid of candidateIds) {
          try {
            const owner = await nft.ownerOf(tid);
            if (owner.toLowerCase() === marketUserAccount.toLowerCase()) {
              ownedTokenIds.push(tid);
            }
          } catch (e) {
            // might have transferred away or listed
          }
        }
      } catch (logErr) {
        console.warn("Transfer log filter failed, falling back to sequential scan:", logErr);
      }

      // If logs query didn't find any or was empty, do sequential scan if collection is reasonably sized
      if (ownedTokenIds.length === 0 && total <= 100) {
        for (let tid = 1; tid <= total; tid++) {
          try {
            const owner = await nft.ownerOf(tid);
            if (owner.toLowerCase() === marketUserAccount.toLowerCase()) {
              ownedTokenIds.push(tid.toString());
            }
          } catch (e) {}
        }
      }
    }

    if (ownedTokenIds.length === 0 && listedTokenIds.length === 0) {
      if (container) container.innerHTML = "";
      if (emptyEl) emptyEl.classList.remove("hidden");
      return;
    }

    if (emptyEl) emptyEl.classList.add("hidden");
    const cardsHtml = [];

    // 1. Render Unlisted Owned NFTs
    for (const tid of ownedTokenIds) {
      let svgHtml = `<div style="padding: 40px; color: var(--text-muted); font-size: 1.5rem;">#${tid}</div>`;
      let tokenName = `Retrial #${tid}`;

      try {
        const tokenUri = await nft.tokenURI(tid);
        const metadata = shared.decodeTokenURI(tokenUri);
        if (metadata?.name) tokenName = metadata.name;
        if (metadata?.image) {
          const svgContent = shared.extractSVG(metadata.image);
          if (svgContent) {
            svgHtml = svgContent;
          } else {
            svgHtml = `<img src="${metadata.image}" alt="${tokenName}" />`;
          }
        }
      } catch (e) {}

      const inputId = `list-price-input-${tid}`;

      cardsHtml.push(`
        <div class="nft-card">
          <div class="nft-card-img-wrap">${svgHtml}</div>
          <div class="nft-card-body">
            <div class="nft-card-title">${tokenName}</div>
            <div style="margin-bottom: 12px;"><span class="badge" style="color:var(--success)"><span class="badge-dot"></span> In Wallet (Unlisted)</span></div>
            <div style="margin-top: auto; display: flex; flex-direction: column; gap: 8px;">
              <div class="input-group">
                <input type="number" step="0.001" min="0.0001" id="${inputId}" class="input-control input-flex" placeholder="Price (BNB)" value="0.05" />
                <button class="btn btn-primary btn-sm" onclick="handleApproveAndList('${tid}', '${inputId}')">List for Sale</button>
              </div>
            </div>
          </div>
        </div>
      `);
    }

    // 2. Render Currently Listed NFTs by User
    for (const l of listedTokenIds) {
      const tid = l.tokenId;
      let svgHtml = `<div style="padding: 40px; color: var(--text-muted); font-size: 1.5rem;">#${tid}</div>`;
      let tokenName = `Retrial #${tid}`;

      try {
        const tokenUri = await nft.tokenURI(tid);
        const metadata = shared.decodeTokenURI(tokenUri);
        if (metadata?.name) tokenName = metadata.name;
        if (metadata?.image) {
          const svgContent = shared.extractSVG(metadata.image);
          if (svgContent) {
            svgHtml = svgContent;
          } else {
            svgHtml = `<img src="${metadata.image}" alt="${tokenName}" />`;
          }
        }
      } catch (e) {}

      cardsHtml.push(`
        <div class="nft-card">
          <div class="nft-card-img-wrap">${svgHtml}</div>
          <div class="nft-card-body">
            <div class="nft-card-title">${tokenName}</div>
            <div style="margin-bottom: 12px;"><span class="badge" style="color:var(--primary)"><span class="badge-dot" style="background-color:var(--primary)"></span> Listed for ${l.priceBnb} BNB</span></div>
            <div style="margin-top: auto; display: flex; gap: 8px;">
              <button class="btn btn-secondary btn-sm" style="flex:1" onclick="handleUpdatePrice('${tid}', '${l.priceBnb}')">Update Price</button>
              <button class="btn btn-danger btn-sm" style="flex:1" onclick="handleCancelListing('${tid}')">Cancel</button>
            </div>
          </div>
        </div>
      `);
    }

    if (container) {
      container.innerHTML = cardsHtml.join("");
    }
  } catch (err) {
    console.error("Error loading My NFTs:", err);
  }
}

async function lookupTokenStatus() {
  const input = document.getElementById("lookup-token-id");
  const resultDiv = document.getElementById("lookup-result");
  const idStr = input?.value?.trim();
  if (!idStr || isNaN(idStr)) {
    alert("Please enter a valid numerical Token ID.");
    return;
  }

  const tid = BigInt(idStr);
  const config = shared.getAppConfig();
  const provider = shared.getReadProvider();
  const nft = new ethers.Contract(config.nftAddress, NFT_ABI, provider);
  const market = new ethers.Contract(config.marketAddress, MARKET_ABI, provider);

  if (resultDiv) {
    resultDiv.classList.remove("hidden");
    resultDiv.innerHTML = "<div class='text-muted'>Checking token...</div>";
  }

  try {
    const owner = await nft.ownerOf(tid);
    const listing = await market.listings(tid);
    const isListed = listing.seller !== ethers.ZeroAddress;

    let statusText = "";
    if (isListed) {
      statusText = `Listed by ${shared.formatAddress(listing.seller)} for ${ethers.formatEther(listing.price)} BNB.`;
    } else {
      statusText = `Owned by ${shared.formatAddress(owner)} (in wallet).`;
    }

    const isYou = marketUserAccount && (owner.toLowerCase() === marketUserAccount.toLowerCase() || (isListed && listing.seller.toLowerCase() === marketUserAccount.toLowerCase()));

    if (resultDiv) {
      resultDiv.innerHTML = `
        <div style="padding: 12px; background: var(--bg-card-inner); border: 1px solid var(--border); border-radius: var(--radius-sm);">
          <strong>Retrial #${tid}:</strong> ${statusText}
          ${isYou ? '<span class="badge" style="color:var(--primary); margin-left: 8px;">Your Token</span>' : ''}
        </div>
      `;
    }
  } catch (err) {
    if (resultDiv) {
      resultDiv.innerHTML = `<div style="padding: 12px; color: var(--danger);">Token #${tid} does not exist or has not been minted yet.</div>`;
    }
  }
}

// ---------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------

function initMarketPage() {
  const marketApp = document.getElementById("market-app");
  if (!marketApp) return; // not the market page

  const connectBtn = document.getElementById("market-connect-wallet-btn");
  if (connectBtn) {
    connectBtn.addEventListener("click", connectMarketWallet);
  }

  const lookupBtn = document.getElementById("lookup-token-btn");
  if (lookupBtn) {
    lookupBtn.addEventListener("click", lookupTokenStatus);
  }

  const refreshBtn = document.getElementById("refresh-market-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      loadMarketData();
      if (marketUserAccount) loadMyNFTs();
    });
  }

  // Wallet event listeners
  if (window.ethereum) {
    window.ethereum.on("accountsChanged", (accounts) => {
      if (!accounts || accounts.length === 0) {
        marketUserAccount = null;
        marketUserSigner = null;
        if (connectBtn) {
          connectBtn.textContent = "Connect Wallet";
          connectBtn.classList.remove("btn-secondary");
          connectBtn.classList.add("btn-primary");
        }
      } else {
        marketUserAccount = accounts[0];
        if (connectBtn) {
          connectBtn.textContent = shared.formatAddress(marketUserAccount);
          connectBtn.title = marketUserAccount;
        }
      }
      loadMarketData();
      loadMyNFTs();
    });

    window.ethereum.on("chainChanged", () => {
      window.location.reload();
    });

    window.ethereum.request({ method: "eth_accounts" }).then((accounts) => {
      if (accounts && accounts.length > 0) {
        marketUserAccount = accounts[0];
        const browserProvider = new ethers.BrowserProvider(window.ethereum);
        browserProvider.getSigner().then((s) => {
          marketUserSigner = s;
        });
        if (connectBtn) {
          connectBtn.textContent = shared.formatAddress(marketUserAccount);
          connectBtn.title = marketUserAccount;
          connectBtn.classList.remove("btn-primary");
          connectBtn.classList.add("btn-secondary");
        }
      }
      checkMarketChain();
      loadMarketData();
      loadMyNFTs();
    }).catch(() => {
      loadMarketData();
    });
  } else {
    loadMarketData();
  }
}

// Make functions accessible to inline onclick handlers
window.handleBuyListing = handleBuyListing;
window.handleCancelListing = handleCancelListing;
window.handleUpdatePrice = handleUpdatePrice;
window.handleApproveAndList = handleApproveAndList;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initMarketPage);
} else {
  initMarketPage();
}
