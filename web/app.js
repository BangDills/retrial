// web/app.js — Retrial NFT Frontend Logic

// ---------------------------------------------------------------------
// 1. Shared Minimal ABI & Config
// ---------------------------------------------------------------------

const RETRIAL_NFT_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function MINT_FEE() view returns (uint256)",
  "function difficultyBits() view returns (uint256)",
  "function maxPerWallet() view returns (uint256)",
  "function mintedBy(address) view returns (uint256)",
  "function usedNonce(address, uint256) view returns (bool)",
  "function totalMinted() view returns (uint256)",
  "function mintedCount() view returns (uint256)",
  "function remaining() view returns (uint256)",
  "function powValid(address minter, uint256 nonce, uint256 bits) view returns (bool)",
  "function mint(uint256 nonce) payable",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Minted(address indexed minter, uint256 indexed tokenId, uint256 nonce, uint256 difficultyBits)"
];

const RETRIAL_MARKET_ABI = [
  "function listings(uint256) view returns (address seller, uint256 price)",
  "function activeListings() view returns (uint256[] ids, tuple(address seller, uint256 price)[] data)",
  "function listedIds() view returns (uint256[])",
  "function list(uint256 tokenId, uint256 price)",
  "function updatePrice(uint256 tokenId, uint256 newPrice)",
  "function cancel(uint256 tokenId)",
  "function buy(uint256 tokenId) payable",
  "function feeBps() view returns (uint256)",
  "event Listed(address indexed seller, uint256 indexed tokenId, uint256 price)",
  "event PriceUpdated(address indexed seller, uint256 indexed tokenId, uint256 newPrice)",
  "event Cancelled(address indexed seller, uint256 indexed tokenId)",
  "event Sold(address indexed seller, address indexed buyer, uint256 indexed tokenId, uint256 price)"
];

// Combine both ABIs so window.RETRIAL_ABI can be used directly or by property
const RETRIAL_ABI = [...RETRIAL_NFT_ABI, ...RETRIAL_MARKET_ABI];
RETRIAL_ABI.nft = RETRIAL_NFT_ABI;
RETRIAL_ABI.market = RETRIAL_MARKET_ABI;
window.RETRIAL_ABI = RETRIAL_ABI;
window.RETRIAL_NFT_ABI = RETRIAL_NFT_ABI;
window.RETRIAL_MARKET_ABI = RETRIAL_MARKET_ABI;

// Network parameters for switching/adding chains
const CHAIN_PARAMS = {
  56: {
    chainId: "0x38",
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.binance.org"],
    blockExplorerUrls: ["https://bscscan.com"]
  },
  97: {
    chainId: "0x61",
    chainName: "BNB Smart Chain Testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: ["https://data-seed-prebsc-1-s1.bnbchain.org:8545"],
    blockExplorerUrls: ["https://testnet.bscscan.com"]
  },
  31337: {
    chainId: "0x7a69",
    chainName: "Hardhat Local",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["http://127.0.0.1:8545"],
    blockExplorerUrls: []
  }
};

// ---------------------------------------------------------------------
// 2. Shared Utilities
// ---------------------------------------------------------------------

function base64ToUtf8(b64) {
  try {
    const binString = atob(b64);
    const bytes = Uint8Array.from(binString, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return atob(b64);
  }
}

function decodeTokenURI(uri) {
  if (!uri || typeof uri !== "string") return null;
  try {
    if (uri.startsWith("data:application/json;base64,")) {
      const b64 = uri.slice("data:application/json;base64,".length);
      const jsonStr = base64ToUtf8(b64);
      return JSON.parse(jsonStr);
    }
    if (uri.startsWith("data:application/json,")) {
      return JSON.parse(decodeURIComponent(uri.slice("data:application/json,".length)));
    }
    if (uri.startsWith("{")) {
      return JSON.parse(uri);
    }
  } catch (err) {
    console.error("Error decoding tokenURI:", err);
  }
  return null;
}

function extractSVG(imageUri) {
  if (!imageUri || typeof imageUri !== "string") return "";
  try {
    if (imageUri.startsWith("data:image/svg+xml;base64,")) {
      const b64 = imageUri.slice("data:image/svg+xml;base64,".length);
      return base64ToUtf8(b64);
    }
    if (imageUri.startsWith("data:image/svg+xml;utf8,")) {
      return decodeURIComponent(imageUri.slice("data:image/svg+xml;utf8,".length));
    }
    if (imageUri.startsWith("data:image/svg+xml,")) {
      return decodeURIComponent(imageUri.slice("data:image/svg+xml,".length));
    }
    if (imageUri.trim().startsWith("<svg")) {
      return imageUri;
    }
  } catch (err) {
    console.error("Error extracting SVG:", err);
  }
  return "";
}

function formatAddress(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function getAppConfig() {
  return window.RETRIAL_CONFIG || {
    chainId: 31337,
    chainName: "Hardhat Local",
    rpcUrl: "http://127.0.0.1:8545",
    nftAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    marketAddress: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    explorer: ""
  };
}

function getReadProvider() {
  const config = getAppConfig();
  try {
    return new ethers.JsonRpcProvider(config.rpcUrl);
  } catch (e) {
    console.error("Failed to construct JsonRpcProvider:", e);
    return null;
  }
}

async function switchOrAddChain(targetChainId) {
  if (!window.ethereum) return false;
  const hexChainId = "0x" + Number(targetChainId).toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }]
    });
    return true;
  } catch (switchError) {
    if (switchError.code === 4902 || switchError.code === -32603) {
      const param = CHAIN_PARAMS[targetChainId];
      if (param) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [param]
          });
          return true;
        } catch (addError) {
          console.error("wallet_addEthereumChain failed:", addError);
          throw addError;
        }
      }
    }
    throw switchError;
  }
}

// In-line solver fallback for environments where Web Worker creation is blocked (e.g. Chrome file://)
function runInlineSolver(address, difficultyBits, onProgress, onSolved) {
  let isCancelled = false;
  const bits = Number(difficultyBits);
  const target = bits === 0 ? (1n << 256n) : (1n << BigInt(256 - bits));
  let nonce = 0n;
  let hashes = 0;
  const startTime = performance.now();
  let lastReport = startTime;

  function step() {
    if (isCancelled) return;
    const batchStart = performance.now();
    while (performance.now() - batchStart < 40) {
      for (let i = 0; i < 300; i++) {
        const hash = ethers.keccak256(
          ethers.solidityPacked(["address", "uint256"], [address, nonce])
        );
        hashes++;

        if (BigInt(hash) < target) {
          const now = performance.now();
          const totalSec = Math.max((now - startTime) / 1000, 0.001);
          const hashrate = Math.round(hashes / totalSec);
          onProgress({ hashes, hashrate });
          onSolved(nonce.toString());
          return;
        }
        nonce++;
      }
    }

    const now = performance.now();
    if (now - lastReport >= 200) {
      const totalSec = Math.max((now - startTime) / 1000, 0.001);
      const hashrate = Math.round(hashes / totalSec);
      onProgress({ hashes, hashrate });
      lastReport = now;
    }

    setTimeout(step, 0);
  }

  step();
  return {
    terminate: () => {
      isCancelled = true;
    }
  };
}

// Export shared items to window for market.js
window.RetrialShared = {
  RETRIAL_NFT_ABI,
  RETRIAL_MARKET_ABI,
  RETRIAL_ABI,
  CHAIN_PARAMS,
  base64ToUtf8,
  decodeTokenURI,
  extractSVG,
  formatAddress,
  getAppConfig,
  getReadProvider,
  switchOrAddChain,
  runInlineSolver
};

// ---------------------------------------------------------------------
// 3. Mint Page Application Logic
// ---------------------------------------------------------------------

let userAccount = null;
let userSigner = null;
let currentChainId = null;
let currentDifficultyBits = 20;
let currentNonce = null;
let activeWorker = null;
let isSolvingChallenge = false;
let isSolvingAgent = false;
let agentWorker = null;

function showInlineAlert(id, message, type = "info", actionBtn = null) {
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

function hideInlineAlert(id) {
  const container = document.getElementById(id);
  if (container) {
    container.classList.add("hidden");
    container.innerHTML = "";
  }
}

async function updateGasEstimate(provider) {
  const gasEstimateEl = document.getElementById("gas-estimate");
  const totalEstimateEl = document.getElementById("total-estimate");
  if (!gasEstimateEl || !totalEstimateEl) return;

  // Measured on a real local chain: the first mint costs ~142.7k gas,
  // later ones ~125.6k. 145k is the safe figure to show.
  const estimatedGasUnits = 145000n;
  const mintFeeWei = 80000000000000n; // 0.00008 BNB

  const fmt = (wei) => {
    const v = parseFloat(ethers.formatEther(wei));
    return v < 0.0001 ? `~${v.toFixed(6)}` : `~${v.toFixed(5)}`;
  };

  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || 100000000n; // BSC floor is 0.05-0.1 gwei
    const estGasCostWei = gasPrice * estimatedGasUnits;

    gasEstimateEl.textContent = `${fmt(estGasCostWei)} BNB`;
    totalEstimateEl.textContent = `${fmt(mintFeeWei + estGasCostWei)} BNB`;
  } catch (e) {
    // Keep a realistic fallback (BSC gas price floor, ~0.1 gwei).
    gasEstimateEl.textContent = "~0.000015 BNB";
    totalEstimateEl.textContent = "~0.000095 BNB";
  }
}

async function refreshMintPageStats() {
  const config = getAppConfig();
  const provider = getReadProvider();
  if (!provider) {
    showInlineAlert(
      "page-alert",
      `Unable to initialize provider for RPC: <code>${config.rpcUrl}</code>.`,
      "error"
    );
    return;
  }

  const nft = new ethers.Contract(config.nftAddress, RETRIAL_NFT_ABI, provider);

  try {
    const [totalMinted, maxSupply, difficultyBits] = await Promise.all([
      nft.totalMinted(),
      nft.MAX_SUPPLY(),
      nft.difficultyBits()
    ]);

    currentDifficultyBits = Number(difficultyBits);

    const statMintedEl = document.getElementById("stat-minted");
    const statRemainingEl = document.getElementById("stat-remaining");
    const statDiffEl = document.getElementById("stat-difficulty");
    const statCapEl = document.getElementById("stat-cap");

    if (statMintedEl) statMintedEl.textContent = `${totalMinted.toString()} / ${maxSupply.toString()}`;
    if (statRemainingEl) statRemainingEl.textContent = (maxSupply - totalMinted).toString();
    if (statDiffEl) statDiffEl.textContent = `${difficultyBits.toString()} bits`;

    // Estimate gas
    await updateGasEstimate(provider);

    // If wallet connected, get wallet-specific stats
    if (userAccount) {
      try {
        const [mintedByYou, maxPerWallet] = await Promise.all([
          nft.mintedBy(userAccount),
          nft.maxPerWallet()
        ]);
        if (statCapEl) {
          statCapEl.textContent = `${mintedByYou.toString()} / ${maxPerWallet.toString()}`;
        }
      } catch (err) {
        console.warn("Could not read wallet stats:", err);
      }
    } else {
      if (statCapEl) statCapEl.textContent = "- / 5";
    }

    hideInlineAlert("page-alert");
  } catch (err) {
    console.error("Failed to read contract stats:", err);
    showInlineAlert(
      "page-alert",
      `<strong>RPC Read Failure:</strong> Could not connect to contract at <code>${config.nftAddress}</code> via <code>${config.rpcUrl}</code>. Please make sure the local node is running or check web/config.js.`,
      "error"
    );
  }
}

async function checkChainAndPrompt() {
  if (!window.ethereum) return true;
  const config = getAppConfig();
  try {
    const hexChainId = await window.ethereum.request({ method: "eth_chainId" });
    currentChainId = parseInt(hexChainId, 16);

    const badge = document.getElementById("network-badge");
    if (badge) {
      badge.textContent = `Chain: ${currentChainId}`;
    }

    if (Number(config.chainId) !== currentChainId) {
      const switchBtn = document.createElement("button");
      switchBtn.className = "btn btn-primary btn-sm";
      switchBtn.textContent = `Switch to ${config.chainName} (${config.chainId})`;
      switchBtn.onclick = async () => {
        try {
          await switchOrAddChain(config.chainId);
          hideInlineAlert("chain-alert");
        } catch (e) {
          showInlineAlert(
            "chain-alert",
            `Failed to switch chain: ${e.message || e}`,
            "error"
          );
        }
      };

      showInlineAlert(
        "chain-alert",
        `⚠️ <strong>Wrong Network:</strong> You are connected to Chain ID ${currentChainId}. This app is configured for <strong>${config.chainName} (${config.chainId})</strong>.`,
        "warning",
        switchBtn
      );
      return false;
    } else {
      hideInlineAlert("chain-alert");
      return true;
    }
  } catch (err) {
    console.warn("Failed to check chainId:", err);
    return true;
  }
}

async function connectWallet() {
  const connectBtn = document.getElementById("connect-wallet-btn");
  hideInlineAlert("wallet-alert");

  if (!window.ethereum) {
    showInlineAlert(
      "wallet-alert",
      "<strong>No Web3 Wallet Detected:</strong> Please install MetaMask or Binance Web3 Wallet to mint on chain. (Read-only mode active via RPC).",
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
      userAccount = accounts[0];
      userSigner = await browserProvider.getSigner();

      if (connectBtn) {
        connectBtn.textContent = formatAddress(userAccount);
        connectBtn.title = userAccount;
        connectBtn.classList.remove("btn-primary");
        connectBtn.classList.add("btn-secondary");
      }

      await checkChainAndPrompt();
      await refreshMintPageStats();

      // Pre-fill agent input if empty
      const agentInput = document.getElementById("agent-wallet-input");
      if (agentInput && !agentInput.value) {
        agentInput.value = userAccount;
      }
    }
  } catch (err) {
    console.error("Connect wallet error:", err);
    if (err.code === 4001 || (err.message && err.message.toLowerCase().includes("rejected"))) {
      showInlineAlert("wallet-alert", "Connection request was rejected by user.", "warning");
    } else {
      showInlineAlert("wallet-alert", `Wallet connection failed: ${err.message || err}`, "error");
    }
  } finally {
    if (connectBtn) connectBtn.disabled = false;
  }
}

function startSolvingChallenge() {
  if (!userAccount) {
    showInlineAlert("mint-alert", "Please connect your wallet first to solve the challenge for your address.", "warning");
    connectWallet();
    return;
  }

  const solveBtn = document.getElementById("solve-btn");
  const mintBtn = document.getElementById("mint-btn");
  const stopBtn = document.getElementById("stop-btn");
  const solverRateEl = document.getElementById("solver-hashrate");
  const solverHashesEl = document.getElementById("solver-hashes");
  const solverStatusEl = document.getElementById("solver-status");
  const verifiedBox = document.getElementById("verified-box");
  const verifiedText = document.getElementById("verified-text");

  hideInlineAlert("mint-alert");
  if (verifiedBox) verifiedBox.classList.add("hidden");
  if (mintBtn) mintBtn.disabled = true;
  currentNonce = null;

  isSolvingChallenge = true;
  if (solveBtn) {
    solveBtn.disabled = true;
    solveBtn.textContent = "Solving Challenge...";
  }
  if (stopBtn) stopBtn.classList.remove("hidden");
  if (solverStatusEl) solverStatusEl.textContent = `Hashing for ${formatAddress(userAccount)} (${currentDifficultyBits} bits)...`;

  const onProgress = ({ hashes, hashrate }) => {
    if (solverRateEl) solverRateEl.textContent = `${hashrate.toLocaleString()} H/s`;
    if (solverHashesEl) solverHashesEl.textContent = hashes.toLocaleString();
  };

  const onSolved = async (nonce) => {
    isSolvingChallenge = false;
    currentNonce = nonce;
    if (solveBtn) {
      solveBtn.disabled = false;
      solveBtn.textContent = "Solve Challenge";
    }
    if (stopBtn) stopBtn.classList.add("hidden");
    if (solverStatusEl) solverStatusEl.textContent = `Found nonce: ${nonce}! Verifying on chain...`;

    // Verify found nonce with READ call to powValid() on chain
    const config = getAppConfig();
    const provider = getReadProvider();
    const nft = new ethers.Contract(config.nftAddress, RETRIAL_NFT_ABI, provider);

    try {
      const isValid = await nft.powValid(userAccount, nonce, currentDifficultyBits);
      if (isValid) {
        if (solverStatusEl) solverStatusEl.textContent = `Solved! Nonce: ${nonce}`;
        if (verifiedBox) verifiedBox.classList.remove("hidden");
        if (verifiedText) {
          verifiedText.innerHTML = `<strong>Challenge Solved:</strong> Nonce <code>${nonce}</code> verified on chain via <code>powValid()</code> = <strong>true</strong>. Ready to mint!`;
        }
        if (mintBtn) {
          mintBtn.disabled = false;
          mintBtn.classList.remove("btn-secondary");
          mintBtn.classList.add("btn-primary");
        }
      } else {
        if (solverStatusEl) solverStatusEl.textContent = "On-chain verification returned FALSE";
        showInlineAlert(
          "mint-alert",
          `Contract powValid(${userAccount}, ${nonce}, ${currentDifficultyBits}) returned <strong>false</strong>. Nonce rejected.`,
          "error"
        );
        if (mintBtn) mintBtn.disabled = true;
      }
    } catch (err) {
      console.error("powValid call failed:", err);
      showInlineAlert(
        "mint-alert",
        `Verification read call powValid() failed on chain: ${err.message || err}`,
        "error"
      );
    }
  };

  try {
    activeWorker = new Worker("solver-worker.js");
    activeWorker.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === "progress") {
        onProgress(d);
      } else if (d.type === "solved") {
        onSolved(d.nonce);
      }
    };
    activeWorker.onerror = (err) => {
      console.warn("Worker error or blocked, falling back to inline solver:", err);
      if (activeWorker) activeWorker.terminate();
      activeWorker = runInlineSolver(userAccount, currentDifficultyBits, onProgress, onSolved);
    };
    activeWorker.postMessage({
      address: userAccount,
      difficultyBits: currentDifficultyBits
    });
  } catch (err) {
    console.warn("Failed to instantiate Worker (likely file:// origin). Using inline solver:", err);
    activeWorker = runInlineSolver(userAccount, currentDifficultyBits, onProgress, onSolved);
  }
}

function stopSolvingChallenge() {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
  isSolvingChallenge = false;
  const solveBtn = document.getElementById("solve-btn");
  const stopBtn = document.getElementById("stop-btn");
  const solverStatusEl = document.getElementById("solver-status");
  if (solveBtn) {
    solveBtn.disabled = false;
    solveBtn.textContent = "Solve Challenge";
  }
  if (stopBtn) stopBtn.classList.add("hidden");
  if (solverStatusEl) solverStatusEl.textContent = "Solver stopped.";
}

async function executeMint() {
  if (!userAccount || !userSigner) {
    showInlineAlert("mint-alert", "Please connect your wallet first.", "warning");
    connectWallet();
    return;
  }
  if (!currentNonce) {
    showInlineAlert("mint-alert", "No verified nonce found. Please solve the challenge first.", "warning");
    return;
  }

  const mintBtn = document.getElementById("mint-btn");
  const solveBtn = document.getElementById("solve-btn");
  const resultCard = document.getElementById("mint-result-card");
  const config = getAppConfig();

  hideInlineAlert("mint-alert");

  try {
    if (mintBtn) {
      mintBtn.disabled = true;
      mintBtn.textContent = "Confirming Transaction...";
    }
    if (solveBtn) solveBtn.disabled = true;

    const nft = new ethers.Contract(config.nftAddress, RETRIAL_NFT_ABI, userSigner);

    // Mint fee: exactly 80000000000000 wei (0.00008 BNB)
    const MINT_FEE_WEI = 80000000000000n;

    showInlineAlert("mint-alert", "Please approve the transaction in your wallet...", "info");
    const tx = await nft.mint(currentNonce, { value: MINT_FEE_WEI });

    showInlineAlert(
      "mint-alert",
      `Transaction submitted: <code>${tx.hash}</code>. Waiting for confirmation...`,
      "info"
    );

    const receipt = await tx.wait();

    // Parse the Transfer log to find the minted token ID
    let mintedTokenId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = nft.interface.parseLog(log);
        if (parsed && parsed.name === "Transfer") {
          mintedTokenId = parsed.args[2]; // tokenId is 3rd param: (from, to, tokenId)
          break;
        }
      } catch (e) {
        // Log belongs to another contract or unparsed
      }
    }

    if (mintedTokenId === null) {
      for (const log of receipt.logs) {
        try {
          const parsed = nft.interface.parseLog(log);
          if (parsed && parsed.name === "Minted") {
            mintedTokenId = parsed.args[1];
            break;
          }
        } catch (e) {}
      }
    }

    if (mintedTokenId !== null) {
      showInlineAlert(
        "mint-alert",
        `🎉 <strong>Success!</strong> Minted Retrial #${mintedTokenId.toString()} in tx <code>${tx.hash}</code>.`,
        "success"
      );

      // Fetch metadata and render SVG inline
      try {
        const tokenUri = await nft.tokenURI(mintedTokenId);
        const metadata = decodeTokenURI(tokenUri);

        if (resultCard) {
          resultCard.classList.remove("hidden");

          const previewEl = document.getElementById("mint-result-preview");
          const titleEl = document.getElementById("mint-result-title");
          const descEl = document.getElementById("mint-result-desc");
          const attrsEl = document.getElementById("mint-result-attributes");

          if (titleEl) titleEl.textContent = metadata?.name || `Retrial #${mintedTokenId}`;
          if (descEl) descEl.textContent = metadata?.description || "Retrial challenge-gated NFT.";

          if (previewEl && metadata?.image) {
            const svgText = extractSVG(metadata.image);
            if (svgText) {
              previewEl.innerHTML = svgText;
            } else {
              previewEl.innerHTML = `<img src="${metadata.image}" alt="NFT Preview" />`;
            }
          }

          if (attrsEl && metadata?.attributes) {
            attrsEl.innerHTML = metadata.attributes
              .map(
                (a) =>
                  `<div class="attribute-tag"><span class="attribute-tag-label">${a.trait_type}</span><strong>${a.value}</strong></div>`
              )
              .join("");
          }
        }
      } catch (uriErr) {
        console.error("Failed to fetch tokenURI:", uriErr);
      }
    } else {
      showInlineAlert(
        "mint-alert",
        `Mint confirmed in tx <code>${tx.hash}</code>! (Unable to parse token ID from receipt).`,
        "success"
      );
    }

    // Reset nonce and refresh stats
    currentNonce = null;
    const verifiedBox = document.getElementById("verified-box");
    if (verifiedBox) verifiedBox.classList.add("hidden");
    await refreshMintPageStats();
  } catch (err) {
    console.error("Mint error:", err);
    if (err.code === 4001 || (err.message && err.message.toLowerCase().includes("user rejected"))) {
      showInlineAlert("mint-alert", "Transaction was rejected by user.", "warning");
    } else {
      showInlineAlert("mint-alert", `Mint failed: ${err.reason || err.message || err}`, "error");
    }
  } finally {
    if (mintBtn) {
      mintBtn.disabled = true;
      mintBtn.textContent = "Mint NFT";
    }
    if (solveBtn) solveBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// 4. Agent Mode (Binance Agentic Wallet - BAW)
// ---------------------------------------------------------------------

function startAgentSolver() {
  const inputEl = document.getElementById("agent-wallet-input");
  const agentBtn = document.getElementById("agent-solve-btn");
  const statusEl = document.getElementById("agent-status");
  const commandsPanel = document.getElementById("agent-commands-panel");
  const previewCmdEl = document.getElementById("agent-preview-cmd");
  const executeCmdEl = document.getElementById("agent-execute-cmd");

  const address = inputEl?.value?.trim();
  if (!address || !ethers.isAddress(address)) {
    if (statusEl) statusEl.textContent = "Please enter a valid Ethereum / BSC address.";
    return;
  }

  hideInlineAlert("agent-alert");
  if (commandsPanel) commandsPanel.classList.add("hidden");
  isSolvingAgent = true;

  if (agentBtn) {
    agentBtn.disabled = true;
    agentBtn.textContent = "Solving PoW for Agent...";
  }
  if (statusEl) statusEl.textContent = `Solving ${currentDifficultyBits}-bit challenge for ${formatAddress(address)}...`;

  const onProgress = ({ hashes, hashrate }) => {
    if (statusEl) {
      statusEl.textContent = `Solving: ${hashes.toLocaleString()} hashes tested (${hashrate.toLocaleString()} H/s)...`;
    }
  };

  const onSolved = async (nonce) => {
    isSolvingAgent = false;
    if (agentBtn) {
      agentBtn.disabled = false;
      agentBtn.textContent = "Generate BAW Commands";
    }

    const config = getAppConfig();
    const provider = getReadProvider();
    const nft = new ethers.Contract(config.nftAddress, RETRIAL_NFT_ABI, provider);

    if (statusEl) statusEl.textContent = `Found nonce ${nonce}! Verifying on chain...`;

    try {
      const isValid = await nft.powValid(address, nonce, currentDifficultyBits);
      if (!isValid) {
        if (statusEl) statusEl.textContent = `Contract rejected nonce ${nonce}.`;
        return;
      }

      if (statusEl) statusEl.textContent = `✅ Challenge solved & verified on chain! Nonce: ${nonce}`;

      // Encode function call: mint(uint256 nonce)
      const iface = new ethers.Interface(RETRIAL_NFT_ABI);
      const inputData = iface.encodeFunctionData("mint", [nonce]);

      const chainId = config.chainId || 97;
      const MINT_FEE_WEI = 80000000000000n;

      const previewCmd = `baw contract-call preview --binanceChainId ${chainId} --from ${address} --to ${config.nftAddress} --value ${MINT_FEE_WEI} --inputData ${inputData} --json`;
      const executeCmd = `baw contract-call execute --requestId <requestId from preview> --json`;

      if (previewCmdEl) previewCmdEl.textContent = previewCmd;
      if (executeCmdEl) executeCmdEl.textContent = executeCmd;
      if (commandsPanel) commandsPanel.classList.remove("hidden");
    } catch (e) {
      console.error("Agent verification failed:", e);
      if (statusEl) statusEl.textContent = `Verification error: ${e.message || e}`;
    }
  };

  try {
    agentWorker = new Worker("solver-worker.js");
    agentWorker.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === "progress") onProgress(d);
      else if (d.type === "solved") onSolved(d.nonce);
    };
    agentWorker.onerror = () => {
      if (agentWorker) agentWorker.terminate();
      agentWorker = runInlineSolver(address, currentDifficultyBits, onProgress, onSolved);
    };
    agentWorker.postMessage({ address, difficultyBits: currentDifficultyBits });
  } catch (err) {
    agentWorker = runInlineSolver(address, currentDifficultyBits, onProgress, onSolved);
  }
}

function copyToClipboard(text, btnElement) {
  navigator.clipboard.writeText(text).then(() => {
    if (btnElement) {
      const orig = btnElement.textContent;
      btnElement.textContent = "Copied!";
      setTimeout(() => {
        btnElement.textContent = orig;
      }, 1500);
    }
  }).catch((err) => {
    console.error("Copy failed:", err);
  });
}

// ---------------------------------------------------------------------
// 5. Mint Page Initialization
// ---------------------------------------------------------------------

function initMintPage() {
  const mintApp = document.getElementById("mint-app");
  if (!mintApp) return; // not the mint page

  const connectBtn = document.getElementById("connect-wallet-btn");
  if (connectBtn) {
    connectBtn.addEventListener("click", connectWallet);
  }

  const solveBtn = document.getElementById("solve-btn");
  if (solveBtn) {
    solveBtn.addEventListener("click", startSolvingChallenge);
  }

  const stopBtn = document.getElementById("stop-btn");
  if (stopBtn) {
    stopBtn.addEventListener("click", stopSolvingChallenge);
  }

  const mintBtn = document.getElementById("mint-btn");
  if (mintBtn) {
    mintBtn.addEventListener("click", executeMint);
  }

  const agentSolveBtn = document.getElementById("agent-solve-btn");
  if (agentSolveBtn) {
    agentSolveBtn.addEventListener("click", startAgentSolver);
  }

  const copyPreviewBtn = document.getElementById("copy-preview-btn");
  if (copyPreviewBtn) {
    copyPreviewBtn.addEventListener("click", () => {
      const cmd = document.getElementById("agent-preview-cmd")?.textContent;
      if (cmd) copyToClipboard(cmd, copyPreviewBtn);
    });
  }

  const copyExecuteBtn = document.getElementById("copy-execute-btn");
  if (copyExecuteBtn) {
    copyExecuteBtn.addEventListener("click", () => {
      const cmd = document.getElementById("agent-execute-cmd")?.textContent;
      if (cmd) copyToClipboard(cmd, copyExecuteBtn);
    });
  }

  // Setup EIP-1193 listeners if wallet present
  if (window.ethereum) {
    window.ethereum.on("accountsChanged", (accounts) => {
      if (!accounts || accounts.length === 0) {
        userAccount = null;
        userSigner = null;
        if (connectBtn) {
          connectBtn.textContent = "Connect Wallet";
          connectBtn.classList.remove("btn-secondary");
          connectBtn.classList.add("btn-primary");
        }
      } else {
        userAccount = accounts[0];
        if (connectBtn) {
          connectBtn.textContent = formatAddress(userAccount);
          connectBtn.title = userAccount;
        }
      }
      refreshMintPageStats();
    });

    window.ethereum.on("chainChanged", () => {
      window.location.reload();
    });

    // Check if already authorized
    window.ethereum.request({ method: "eth_accounts" }).then((accounts) => {
      if (accounts && accounts.length > 0) {
        userAccount = accounts[0];
        const browserProvider = new ethers.BrowserProvider(window.ethereum);
        browserProvider.getSigner().then((s) => {
          userSigner = s;
        });
        if (connectBtn) {
          connectBtn.textContent = formatAddress(userAccount);
          connectBtn.title = userAccount;
          connectBtn.classList.remove("btn-primary");
          connectBtn.classList.add("btn-secondary");
        }
      }
      checkChainAndPrompt();
      refreshMintPageStats();
    }).catch(() => {
      refreshMintPageStats();
    });
  } else {
    // Read-only initialization via RPC
    refreshMintPageStats();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initMintPage);
} else {
  initMintPage();
}
