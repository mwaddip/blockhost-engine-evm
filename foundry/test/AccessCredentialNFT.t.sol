// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AccessCredentialNFT.sol";

contract AccessCredentialNFTTest is Test {
    AccessCredentialNFT public nft;
    address public owner;
    address public alice;
    address public bob;

    function setUp() public {
        owner = address(this);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        nft = new AccessCredentialNFT("BlockhostAccess", "BHA");
    }

    // --- Mint ---

    function test_mint_basic() public {
        bytes memory encrypted = hex"deadbeef";
        uint256 tokenId = nft.mint(alice, encrypted);

        assertEq(tokenId, 0);
        assertEq(nft.ownerOf(0), alice);
        assertEq(nft.getUserEncrypted(0), encrypted);
    }

    function test_mint_empty_userEncrypted() public {
        uint256 tokenId = nft.mint(alice, "");
        assertEq(tokenId, 0);
        assertEq(nft.getUserEncrypted(0), "");
    }

    function test_mint_increments_tokenId() public {
        nft.mint(alice, "");
        nft.mint(bob, "");
        nft.mint(alice, hex"aabb");

        assertEq(nft.ownerOf(0), alice);
        assertEq(nft.ownerOf(1), bob);
        assertEq(nft.ownerOf(2), alice);
    }

    function test_mint_emits_CredentialMinted() public {
        vm.expectEmit(true, true, false, false);
        emit AccessCredentialNFT.CredentialMinted(0, alice);
        nft.mint(alice, hex"cafe");
    }

    function test_mint_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        nft.mint(bob, "");
    }

    // --- getUserEncrypted ---

    function test_getUserEncrypted_nonexistent_reverts() public {
        vm.expectRevert("Token does not exist");
        nft.getUserEncrypted(0);
    }

    // --- updateUserEncrypted ---

    function test_updateUserEncrypted() public {
        nft.mint(alice, hex"0001");
        nft.updateUserEncrypted(0, hex"0002");
        assertEq(nft.getUserEncrypted(0), hex"0002");
    }

    function test_updateUserEncrypted_emits_CredentialUpdated() public {
        nft.mint(alice, "");
        vm.expectEmit(true, false, false, false);
        emit AccessCredentialNFT.CredentialUpdated(0);
        nft.updateUserEncrypted(0, hex"ff");
    }

    function test_updateUserEncrypted_onlyOwner() public {
        nft.mint(alice, "");
        vm.prank(alice);
        vm.expectRevert();
        nft.updateUserEncrypted(0, hex"ff");
    }

    function test_updateUserEncrypted_nonexistent_reverts() public {
        vm.expectRevert("Token does not exist");
        nft.updateUserEncrypted(99, hex"ff");
    }

    // --- Transfer ---

    function test_transfer() public {
        nft.mint(alice, hex"ab");

        vm.prank(alice);
        nft.transferFrom(alice, bob, 0);

        assertEq(nft.ownerOf(0), bob);
        // userEncrypted persists after transfer
        assertEq(nft.getUserEncrypted(0), hex"ab");
    }

    // --- Enumerable ---

    function test_totalSupply() public {
        assertEq(nft.totalSupply(), 0);
        nft.mint(alice, "");
        assertEq(nft.totalSupply(), 1);
        nft.mint(bob, "");
        assertEq(nft.totalSupply(), 2);
    }

    function test_balanceOf() public {
        nft.mint(alice, "");
        nft.mint(alice, "");
        nft.mint(bob, "");

        assertEq(nft.balanceOf(alice), 2);
        assertEq(nft.balanceOf(bob), 1);
    }

    function test_tokenOfOwnerByIndex() public {
        nft.mint(alice, "");
        nft.mint(bob, "");
        nft.mint(alice, "");

        assertEq(nft.tokenOfOwnerByIndex(alice, 0), 0);
        assertEq(nft.tokenOfOwnerByIndex(alice, 1), 2);
        assertEq(nft.tokenOfOwnerByIndex(bob, 0), 1);
    }
}
