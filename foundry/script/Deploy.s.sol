// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AccessCredentialNFT.sol";

contract DeployAccessCredentialNFT is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        AccessCredentialNFT nft = new AccessCredentialNFT(
            "BlockhostAccess",
            "BHA"
        );

        console.log("AccessCredentialNFT deployed to:", address(nft));

        vm.stopBroadcast();
    }
}
