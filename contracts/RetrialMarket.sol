// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RetrialMarket is Ownable, ReentrancyGuard, IERC721Receiver {
    struct Listing {
        address seller;
        uint256 price;
    }

    IERC721 public immutable nft;
    uint256 public feeBps = 0;

    mapping(uint256 => Listing) public listings;
    uint256[] private _listedIds;
    mapping(uint256 => uint256) private _listedIndex;

    event Listed(address indexed seller, uint256 indexed tokenId, uint256 price);
    event PriceUpdated(address indexed seller, uint256 indexed tokenId, uint256 newPrice);
    event Cancelled(address indexed seller, uint256 indexed tokenId);
    event Sold(
        address indexed seller,
        address indexed buyer,
        uint256 indexed tokenId,
        uint256 price
    );
    event FeeBpsUpdated(uint256 feeBps);

    constructor(address nftAddress) Ownable(msg.sender) {
        require(nftAddress != address(0), "Invalid NFT address");
        nft = IERC721(nftAddress);
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function list(uint256 tokenId, uint256 price) external nonReentrant {
        require(nft.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(price > 0, "Price must be > 0");
        require(listings[tokenId].seller == address(0), "Already listed");

        nft.safeTransferFrom(msg.sender, address(this), tokenId);

        listings[tokenId] = Listing(msg.sender, price);
        _listedIndex[tokenId] = _listedIds.length;
        _listedIds.push(tokenId);

        emit Listed(msg.sender, tokenId, price);
    }

    function updatePrice(uint256 tokenId, uint256 newPrice) external {
        Listing storage listing = listings[tokenId];
        require(listing.seller == msg.sender, "Not seller");
        require(newPrice > 0, "Price must be > 0");

        listing.price = newPrice;
        emit PriceUpdated(msg.sender, tokenId, newPrice);
    }

    function cancel(uint256 tokenId) external nonReentrant {
        Listing memory listing = listings[tokenId];
        require(listing.seller == msg.sender, "Not seller");

        _removeListing(tokenId);
        delete listings[tokenId];

        nft.safeTransferFrom(address(this), msg.sender, tokenId);

        emit Cancelled(msg.sender, tokenId);
    }

    function buy(uint256 tokenId) external payable nonReentrant {
        Listing memory listing = listings[tokenId];
        require(listing.seller != address(0), "Not listed");
        require(msg.value == listing.price, "Incorrect price");

        _removeListing(tokenId);
        delete listings[tokenId];

        uint256 fee = (msg.value * feeBps) / 10000;
        uint256 sellerAmount = msg.value - fee;

        nft.safeTransferFrom(address(this), msg.sender, tokenId);

        (bool success, ) = listing.seller.call{value: sellerAmount}("");
        require(success, "Payment to seller failed");

        emit Sold(listing.seller, msg.sender, tokenId, msg.value);
    }

    function activeListings()
        external
        view
        returns (uint256[] memory ids, Listing[] memory data)
    {
        uint256 len = _listedIds.length;
        ids = new uint256[](len);
        data = new Listing[](len);
        for (uint256 i = 0; i < len; i++) {
            uint256 tokenId = _listedIds[i];
            ids[i] = tokenId;
            data[i] = listings[tokenId];
        }
    }

    function listedIds() external view returns (uint256[] memory) {
        return _listedIds;
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 500, "Fee exceeds max 500 bps");
        feeBps = newFeeBps;
        emit FeeBpsUpdated(newFeeBps);
    }

    function withdrawFees(address to) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        uint256 balance = address(this).balance;
        (bool success, ) = to.call{value: balance}("");
        require(success, "Withdraw failed");
    }

    function _removeListing(uint256 tokenId) internal {
        uint256 index = _listedIndex[tokenId];
        uint256 lastIndex = _listedIds.length - 1;
        if (index != lastIndex) {
            uint256 lastTokenId = _listedIds[lastIndex];
            _listedIds[index] = lastTokenId;
            _listedIndex[lastTokenId] = index;
        }
        _listedIds.pop();
        delete _listedIndex[tokenId];
    }
}
