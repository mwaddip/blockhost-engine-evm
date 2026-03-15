# Engine Manifest (`engine.json`)

Declares engine identity, wizard plugin module, finalization steps, and chain-specific `constraints` used by consumers (installer, admin panel) for input validation and UI rendering.

## `constraints`

| Field | Description | EVM value |
|-------|-------------|-----------|
| `address_pattern` | Regex for valid addresses | `^0x[0-9a-fA-F]{40}$` |
| `signature_pattern` | Regex for valid signatures | `^0x[0-9a-fA-F]{130}$` |
| `native_token` | Native currency keyword for CLIs | `eth` |
| `native_token_label` | Display label for native currency | `ETH` |
| `token_pattern` | Regex for valid token addresses | `^0x[0-9a-fA-F]{40}$` |
| `address_placeholder` | Placeholder for address inputs | `0x...` |

All patterns are anchored regexes. If `constraints` is absent, consumers skip format validation and let CLIs reject invalid input.
