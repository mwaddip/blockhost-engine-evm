/**
 * Generic addressbook types — role-to-wallet mapping for /etc/blockhost/addressbook.json.
 * Lives outside fund-manager because the addressbook is a generic local-config concern
 * (used by the ab CLI, bw CLI, and fund-manager).
 */

export interface AddressbookEntry {
  address: string;
  keyfile?: string;
}

export type Addressbook = Record<string, AddressbookEntry>;
