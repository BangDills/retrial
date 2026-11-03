// web/solver-worker.js
// Proof-of-work solver worker for RetrialNFT (Retrial PoW challenge)
// Loaded via Web Worker

if (typeof importScripts === "function") {
  try {
    importScripts("https://cdn.jsdelivr.net/npm/ethers@6/dist/ethers.umd.min.js");
  } catch (err) {
    console.error("solver-worker: Failed to importScripts ethers:", err);
  }
}

let isSolving = false;

self.onmessage = function (e) {
  const data = e.data || {};

  if (data.type === "stop") {
    isSolving = false;
    return;
  }

  const { address, difficultyBits, startNonce } = data;
  if (!address || difficultyBits === undefined) {
    return;
  }

  const bits = Number(difficultyBits);
  // Target: h < (2^256 >> bits) <=> (h >> (256 - bits)) == 0
  const target = bits === 0 ? (1n << 256n) : (1n << BigInt(256 - bits));

  let nonce = BigInt(startNonce || 0);
  let hashes = 0;
  let lastReport = performance.now();
  const startTime = lastReport;
  isSolving = true;

  function runBatch() {
    if (!isSolving) return;

    // Run a slice of hashes (~40-50ms) to maximize throughput while staying responsive to aborts
    const batchStart = performance.now();
    while (performance.now() - batchStart < 45) {
      for (let i = 0; i < 400; i++) {
        // Must use ethers.keccak256(ethers.solidityPacked(['address','uint256'],[address, nonce]))
        const hash = ethers.keccak256(
          ethers.solidityPacked(["address", "uint256"], [address, nonce])
        );
        hashes++;

        if (BigInt(hash) < target) {
          isSolving = false;
          const now = performance.now();
          const totalSec = Math.max((now - startTime) / 1000, 0.001);
          const hashrate = Math.round(hashes / totalSec);
          self.postMessage({
            type: "progress",
            hashes,
            hashrate,
          });
          self.postMessage({
            type: "solved",
            nonce: nonce.toString(),
            hash,
            hashes,
          });
          return;
        }

        nonce++;
      }
    }

    const now = performance.now();
    if (now - lastReport >= 200) {
      const totalSec = Math.max((now - startTime) / 1000, 0.001);
      const hashrate = Math.round(hashes / totalSec);
      self.postMessage({
        type: "progress",
        hashes,
        hashrate,
      });
      lastReport = now;
    }

    if (isSolving) {
      setTimeout(runBatch, 0);
    }
  }

  runBatch();
};
