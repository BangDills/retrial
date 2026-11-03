// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title Retrial — challenge-gated NFT
/// @notice Minting requires solving a proof-of-work challenge that this contract
///         verifies on chain, so the gate cannot be bypassed by calling the
///         contract directly. One solved challenge = one NFT.
/// @dev Uses OpenZeppelin ERC721 (evmVersion cancun for OZ v5 utils).
contract RetrialNFT is ERC721, Ownable {
    using Strings for uint256;

    /// @notice Hard cap on the collection size.
    uint256 public immutable MAX_SUPPLY;

    /// @notice Fee charged per mint, in wei. 0.00008 BNB.
    ///         The UI headlines the mint as "FREE (gas only)"; this is the
    ///         on-chain minting fee that is actually collected.
    uint256 public constant MINT_FEE = 0.00008 ether;

    /// @notice Number of leading zero bits required in keccak256(minter, nonce).
    uint256 public difficultyBits = 20;

    /// @notice Maximum NFTs a single wallet may mint.
    uint256 public maxPerWallet = 5;

    /// @notice How many NFTs each wallet has minted.
    mapping(address => uint256) public mintedBy;

    /// @notice Whether a given nonce has already been spent by a wallet.
    mapping(address => mapping(uint256 => bool)) public usedNonce;

    /// @notice Total NFTs minted so far (token ids are 1..totalMinted).
    uint256 public totalMinted;

    event Minted(
        address indexed minter,
        uint256 indexed tokenId,
        uint256 nonce,
        uint256 difficultyBits
    );
    event DifficultyBitsUpdated(uint256 difficultyBits);
    event MaxPerWalletUpdated(uint256 maxPerWallet);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(
        uint256 maxSupply_
    ) ERC721("Retrial", "RTR") Ownable(msg.sender) {
        MAX_SUPPLY = maxSupply_ == 0 ? 3000 : maxSupply_;
    }

    // ---------------------------------------------------------------------
    // Challenge verification
    // ---------------------------------------------------------------------

    /// @notice True when keccak256(abi.encodePacked(minter, nonce)) has at least
    ///         `bits` leading zero bits. Pure, so the frontend can pre-check a
    ///         solved nonce and the tests can grade one.
    function powValid(
        address minter,
        uint256 nonce,
        uint256 bits
    ) public pure returns (bool) {
        if (bits == 0) return true;
        if (bits > 256) return false;
        uint256 h = uint256(keccak256(abi.encodePacked(minter, nonce)));
        return (h >> (256 - bits)) == 0;
    }

    /// @notice Mint one NFT by presenting a solved challenge.
    /// @param nonce A nonce satisfying `powValid(msg.sender, nonce, difficultyBits)`.
    function mint(uint256 nonce) external payable {
        require(totalMinted < MAX_SUPPLY, "Max supply reached");
        require(msg.value == MINT_FEE, "Incorrect mint fee");
        require(mintedBy[msg.sender] < maxPerWallet, "Max per wallet reached");
        require(!usedNonce[msg.sender][nonce], "Nonce already used");
        require(
            powValid(msg.sender, nonce, difficultyBits),
            "Invalid proof of work"
        );

        usedNonce[msg.sender][nonce] = true;
        mintedBy[msg.sender] += 1;
        uint256 tokenId = ++totalMinted;

        _safeMint(msg.sender, tokenId);

        emit Minted(msg.sender, tokenId, nonce, difficultyBits);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function mintedCount() external view returns (uint256) {
        return totalMinted;
    }

    function remaining() external view returns (uint256) {
        return MAX_SUPPLY - totalMinted;
    }

    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setDifficultyBits(uint256 bits) external onlyOwner {
        require(bits >= 8 && bits <= 32, "Invalid difficulty bits");
        difficultyBits = bits;
        emit DifficultyBitsUpdated(bits);
    }

    function setMaxPerWallet(uint256 max) external onlyOwner {
        require(max > 0, "Invalid max per wallet");
        maxPerWallet = max;
        emit MaxPerWalletUpdated(max);
    }

    function withdraw(address to) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        uint256 balance = address(this).balance;
        (bool success, ) = to.call{value: balance}("");
        require(success, "Withdraw failed");
        emit Withdrawn(to, balance);
    }

    // ---------------------------------------------------------------------
    // On-chain metadata
    // ---------------------------------------------------------------------

    function _generateSVG(
        uint256 tokenId
    ) internal pure returns (string memory) {
        uint256 hue = (tokenId * 137) % 360;
        string memory sHue = hue.toString();
        string memory sId = tokenId.toString();

        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">',
                '<rect width="400" height="400" rx="24" fill="hsl(',
                sHue,
                ',80%,20%)"/>',
                '<circle cx="200" cy="180" r="90" fill="none" stroke="hsl(',
                sHue,
                ',100%,70%)" stroke-width="4"/>',
                '<text x="200" y="195" font-family="monospace" font-size="44" font-weight="bold" fill="#ffffff" text-anchor="middle">#',
                sId,
                "</text>",
                '<text x="200" y="320" font-family="sans-serif" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">RETRIAL</text>',
                "</svg>"
            )
        );
    }

    function _buildJSON(
        uint256 tokenId
    ) internal view returns (string memory) {
        string memory sId = tokenId.toString();
        string memory imageUri = string(
            abi.encodePacked(
                "data:image/svg+xml;base64,",
                Base64.encode(bytes(_generateSVG(tokenId)))
            )
        );

        return string(
            abi.encodePacked(
                '{"name":"Retrial #',
                sId,
                '","description":"Retrial challenge-gated NFT. Minted by solving an on-chain proof-of-work challenge.",',
                '"image":"',
                imageUri,
                '","attributes":[{"trait_type":"Challenge bits","value":',
                difficultyBits.toString(),
                '},{"trait_type":"Mint fee","value":"0.00008 BNB"},{"trait_type":"Token id","value":',
                sId,
                "}]}"
            )
        );
    }

    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        _requireOwned(tokenId);
        return
            string(
                abi.encodePacked(
                    "data:application/json;base64,",
                    Base64.encode(bytes(_buildJSON(tokenId)))
                )
            );
    }
}
