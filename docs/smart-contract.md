# Smart Contract

**BlockhostSubscriptions.sol** handles:

- **Plans** - Subscription tiers with USD pricing (cents/day)
- **Subscriptions** - User subscriptions with expiration timestamps
- **Payments** - ERC20 tokens (USDC primary, others via Uniswap pricing)
- **NFT Minting** - Each subscription gets an NFT with embedded signing page

## Key Functions

```solidity
// Admin
createPlan(name, pricePerDayUsdCents)
setPrimaryStablecoin(tokenAddress)

// Users
buySubscription(planId, days, paymentMethodId, userEncrypted)
extendSubscription(subscriptionId, days, paymentMethodId)
cancelSubscription(subscriptionId)

// Queries
getSubscription(subscriptionId)
isSubscriptionActive(subscriptionId)
```
