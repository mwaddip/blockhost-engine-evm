/**
 * Shared NFT contract ABI fragments
 *
 * Replaces 4 independent definitions across who.ts, is/index.ts,
 * reconcile/index.ts, and set.ts.
 */

export const NFT_READ_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function totalSupply() view returns (uint256)",
];

export const NFT_WRITE_ABI = [
  "function updateUserEncrypted(uint256, bytes) external",
];
