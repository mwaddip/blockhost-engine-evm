// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AccessCredentialNFT
 * @notice ERC-721 NFT contract for Web3-based Linux authentication credentials
 * @dev Each NFT grants access to a specific server. Authentication is based on:
 *      1. Wallet ownership (user signs challenge)
 *      2. NFT ownership (token ID matches GECOS entry in /etc/passwd)
 *      Connection details can be encrypted for the user in userEncrypted field.
 */
contract AccessCredentialNFT is ERC721, ERC721Enumerable, Ownable {
    /// @notice Counter for token IDs
    uint256 private _nextTokenId;

    /// @notice Encrypted connection details per token
    mapping(uint256 => bytes) private _userEncrypted;

    /// @notice Emitted when a new credential is minted
    event CredentialMinted(uint256 indexed tokenId, address indexed recipient);

    /// @notice Emitted when a credential's encrypted data is updated
    event CredentialUpdated(uint256 indexed tokenId);

    constructor(
        string memory name,
        string memory symbol
    ) ERC721(name, symbol) Ownable(msg.sender) {}

    /**
     * @notice Mint a new access credential NFT
     * @param to Recipient address (the user who will use this credential)
     * @param userEncrypted Connection details encrypted with signature-derived key
     * @return tokenId The ID of the newly minted token
     */
    function mint(
        address to,
        bytes calldata userEncrypted
    ) external onlyOwner returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _userEncrypted[tokenId] = userEncrypted;
        _safeMint(to, tokenId);
        emit CredentialMinted(tokenId, to);
    }

    /**
     * @notice Update the user-encrypted data for an existing credential
     * @param tokenId The token to update
     * @param newUserEncrypted New encrypted connection details
     */
    function updateUserEncrypted(
        uint256 tokenId,
        bytes calldata newUserEncrypted
    ) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        _userEncrypted[tokenId] = newUserEncrypted;
        emit CredentialUpdated(tokenId);
    }

    /**
     * @notice Get the encrypted connection details for a token
     * @param tokenId The token ID
     * @return The encrypted connection details
     */
    function getUserEncrypted(uint256 tokenId) external view returns (bytes memory) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return _userEncrypted[tokenId];
    }

    // Required overrides for ERC721Enumerable

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721, ERC721Enumerable) returns (address) {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(
        address account,
        uint128 value
    ) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
