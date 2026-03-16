# Fund Manager

Integrated into the monitor polling loop. Automates fund withdrawal from the contract, revenue sharing, and gas management.

## Fund Cycle (every 24h, configurable)

1. **Withdraw** — For each payment method token with balance > $50, call `withdrawFunds()` to move tokens from contract to hot wallet
2. **Hot wallet gas** — Server sends ETH to hot wallet if below threshold (default 0.01 ETH)
3. **Server stablecoin buffer** — Hot wallet sends stablecoin to server if below threshold (default $50)
4. **Revenue shares** — If enabled in `revenue-share.json`, distribute configured % to dev/broker
5. **Remainder to admin** — Send all remaining hot wallet token balances to admin

## Gas Check (every 30min, configurable)

- Top up hot wallet ETH from server if below threshold
- Check server wallet ETH balance; if below `gas_low_threshold_usd` ($5), swap USDC→ETH via Uniswap V2

## Hot Wallet

Auto-generated on first fund cycle if not in addressbook. Private key saved to `/etc/blockhost/hot.key` (chmod 600). Acts as an intermediary for distribution — contract funds flow through it before going to recipients.

## Configuration

In `/etc/blockhost/blockhost.yaml` under the `fund_manager:` key:

| Setting | Default | Description |
|---|---|---|
| `fund_cycle_interval_hours` | 24 | Hours between fund cycles |
| `gas_check_interval_minutes` | 30 | Minutes between gas checks |
| `min_withdrawal_usd` | 50 | Minimum USD value to trigger withdrawal |
| `gas_low_threshold_usd` | 5 | Server ETH balance (in USD) that triggers a swap |
| `gas_swap_amount_usd` | 20 | USDC amount to swap for ETH |
| `server_stablecoin_buffer_usd` | 50 | Target stablecoin balance for server wallet |
| `hot_wallet_gas_eth` | 0.01 | Target ETH balance for hot wallet |

Revenue sharing is configured in `/etc/blockhost/revenue-share.json`:

```json
{
  "enabled": true,
  "total_percent": 1.0,
  "recipients": [
    { "role": "dev", "percent": 0.5 },
    { "role": "broker", "percent": 0.5 }
  ]
}
```
