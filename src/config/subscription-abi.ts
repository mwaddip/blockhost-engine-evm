/**
 * Shared subscription contract ABI.
 *
 * Single source of truth for the BlockhostSubscriptions contract surface.
 * Mirrors src/config/nft-abi.ts. Imported by the monitor (events for log
 * decoding), fund-manager (functions for tx calls), and bw CLI commands.
 */

export const SUBSCRIPTION_ABI = [
  // --- functions ---
  "function withdrawFunds(address tokenAddress, address to) external",
  "function getPaymentMethodIds() view returns (uint256[])",
  "function getPaymentMethod(uint256) view returns (address tokenAddress, address pairAddress, address stablecoinAddress, uint8 tokenDecimals, uint8 stablecoinDecimals, bool active)",
  "function getPrimaryStablecoin() view returns (address)",
  "function setPrimaryStablecoin(address) external",
  "function createPlan(string, uint256) external returns (uint256)",
  "function getTokenPriceUsdCents(uint256) view returns (uint256)",
  "function owner() view returns (address)",
  // --- events ---
  "event PlanCreated(uint256 indexed planId, string name, uint256 pricePerDayUsdCents)",
  "event PlanUpdated(uint256 indexed planId, string name, uint256 pricePerDayUsdCents, bool active)",
  "event SubscriptionCreated(uint256 indexed subscriptionId, uint256 indexed planId, address indexed subscriber, uint256 expiresAt, uint256 paidAmount, address paymentToken, bytes userEncrypted)",
  "event SubscriptionExtended(uint256 indexed subscriptionId, uint256 indexed planId, address indexed extendedBy, uint256 newExpiresAt, uint256 paidAmount, address paymentToken)",
  "event SubscriptionCancelled(uint256 indexed subscriptionId, uint256 indexed planId, address indexed subscriber)",
  "event PrimaryStablecoinSet(address indexed stablecoinAddress, uint8 decimals)",
  "event PaymentMethodAdded(uint256 indexed paymentMethodId, address tokenAddress, address pairAddress, address stablecoinAddress)",
  "event PaymentMethodUpdated(uint256 indexed paymentMethodId, bool active)",
  "event FundsWithdrawn(address indexed token, address indexed to, uint256 amount)",
];
