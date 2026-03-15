# CLI Reference

## bw (blockwallet)

Standalone CLI for scriptable wallet operations. Uses the same `RPC_URL` and `BLOCKHOST_CONTRACT` env vars as the monitor.

```bash
bw send <amount> <token> <from> <to>       # Send tokens between wallets
bw balance <role> [token]                   # Show wallet balances
bw split <amount> <token> <ratios> <from> <to1> <to2> ...  # Split tokens
bw withdraw [token] <to>                    # Withdraw from contract
bw swap <amount> <from-token> eth <wallet>  # Swap token for ETH via Uniswap V2
bw who <identifier>                        # Query NFT owner by token ID or 'admin'
bw who <message> <signature>               # Recover signer address from signature
bw config stable [address]                 # Get/set primary stablecoin
bw plan create <name> <price>              # Create subscription plan
bw set encrypt <nft_id> <data>             # Update NFT encrypted data
```

- **Token shortcuts**: `eth` (native), `stable` (contract's primary stablecoin), or `0x` address
- **Roles**: `admin`, `server`, `hot`, `dev`, `broker` (resolved from addressbook.json)
- **Signing**: Only roles with `keyfile` in addressbook can be used as `<from>`/`<wallet>`
- **`bw who`**: Queries NFT ownership or recovers signer address. Config from `web3-defaults.yaml` — no env vars or addressbook needed.
- **`bw config stable`**: No arg reads current primary stablecoin; with arg sets it (owner-only).
- **`bw plan create`**: Creates a subscription plan, prints the plan ID.
- **`bw set encrypt`**: Updates the `userEncrypted` field on an NFT. NFT contract from `web3-defaults.yaml`.

The fund-manager module imports `executeSend()`, `executeWithdraw()`, and `executeSwap()` from the bw command modules directly — all wallet operations flow through the same code paths.

## ab (addressbook)

Standalone CLI for managing wallet entries in `/etc/blockhost/addressbook.json`. No RPC or contract env vars required — purely local filesystem operations.

```bash
ab add <name> <0xaddress>    # Add new entry
ab del <name>                # Delete entry
ab up <name> <0xaddress>     # Update entry's address
ab new <name>                # Generate new wallet, save key, add to addressbook
ab list                      # Show all entries
ab --init <admin> <server> [dev] [broker] <keyfile>  # Bootstrap addressbook
```

- **Immutable roles**: `server`, `admin`, `hot`, `dev`, `broker` — cannot be added, deleted, updated, or generated via `ab`
- **`ab new`**: Generates a keypair, saves private key to `/etc/blockhost/<name>.key` (chmod 600), same pattern as hot wallet generation
- **`ab up`**: Only changes the address; preserves existing `keyfile` if present
- **`ab del`**: Removes the entry from JSON but does NOT delete the keyfile (if any)
- **`ab --init`**: Bootstrap addressbook with admin, server, and optionally dev/broker addresses. Keyfile (last arg) marks the end of input. Only works on an empty addressbook (fresh install safety).

## is (identity predicate)

Standalone binary for yes/no identity questions. Exit 0 = yes, 1 = no. No env vars or addressbook needed — config from `web3-defaults.yaml`.

```bash
is <wallet> <nft_id>         # Does wallet own NFT token?
is contract <address>        # Does a contract exist at address?
```

Arguments are order-independent, disambiguated by type (address = `0x` + 40 hex, NFT ID = integer, `contract` = keyword). Signature verification is handled by `bw who <message> <signature>`.
