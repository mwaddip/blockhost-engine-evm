import { ethers } from "hardhat";
import { execSync } from "child_process";
import * as fs from "fs";
import * as yaml from "js-yaml";

// Paths
const NFT_CONTRACT_PATH = "/usr/share/blockhost/contracts/AccessCredentialNFT.sol";
const WEB3_CONFIG_PATH = "/etc/blockhost/web3-defaults.yaml";

interface Web3Config {
  blockchain: {
    chain_id: number;
    nft_contract: string;
    rpc_url: string;
  };
  deployer: {
    private_key_file: string;
  };
  signing_page: {
    port: number;
    html_path: string;
  };
  auth: {
    otp_length: number;
    otp_ttl_seconds: number;
  };
}

/**
 * Deploy AccessCredentialNFT using forge
 * Returns the deployed contract address
 *
 * Constructor takes name and symbol only.
 */
async function deployNFTContract(
  deployerKey: string,
  rpcUrl: string
): Promise<string> {
  console.log("\n--- Deploying AccessCredentialNFT ---");

  // Check that the contract source exists
  if (!fs.existsSync(NFT_CONTRACT_PATH)) {
    throw new Error(
      `NFT contract not found at ${NFT_CONTRACT_PATH}. ` +
      `Ensure blockhost-engine is installed`
    );
  }

  const name = "BlockhostAccess";
  const symbol = "BHA";

  console.log(`Contract source: ${NFT_CONTRACT_PATH}`);
  console.log(`NFT Name: ${name}`);
  console.log(`NFT Symbol: ${symbol}`);

  // Use forge to deploy
  // Note: forge create needs the contract in a forge project structure,
  // so we use cast to send a deployment transaction with the bytecode

  // For simplicity, we'll compile and deploy using forge create with --root pointing
  // to a temp directory, or use the pre-compiled ABI/bytecode if available

  const abiPath = "/usr/share/blockhost/contracts/AccessCredentialNFT.json";

  if (fs.existsSync(abiPath)) {
    // Use pre-compiled bytecode from the package
    const abiJson = JSON.parse(fs.readFileSync(abiPath, "utf8"));
    const bytecode = abiJson.bytecode?.object || abiJson.bytecode;

    if (!bytecode) {
      throw new Error("No bytecode found in ABI JSON file");
    }

    // Encode constructor arguments
    const iface = new ethers.Interface([
      "constructor(string name, string symbol)"
    ]);
    const encodedArgs = iface.encodeDeploy([name, symbol]);

    // Combine bytecode + constructor args
    const deployData = bytecode + encodedArgs.slice(2); // remove 0x from encoded args

    // Deploy using cast
    const result = execSync(
      `cast send --create "${deployData}" --private-key "${deployerKey}" --rpc-url "${rpcUrl}" --json`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );

    const txResult = JSON.parse(result);
    const contractAddress = txResult.contractAddress;

    if (!contractAddress) {
      throw new Error(`Deployment failed: ${JSON.stringify(txResult)}`);
    }

    console.log(`AccessCredentialNFT deployed to: ${contractAddress}`);
    return contractAddress;
  } else {
    // Compile on-the-fly using forge (requires foundry and OpenZeppelin contracts)
    console.log("Pre-compiled bytecode not found, compiling with forge...");

    // Create a temporary forge project
    const tmpDir = `/tmp/blockhost-nft-deploy-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(`${tmpDir}/src`, { recursive: true });

    // Copy contract
    fs.copyFileSync(NFT_CONTRACT_PATH, `${tmpDir}/src/AccessCredentialNFT.sol`);

    // Create foundry.toml
    fs.writeFileSync(`${tmpDir}/foundry.toml`, `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
`);

    // Install OpenZeppelin (required dependency)
    execSync(`cd ${tmpDir} && forge install OpenZeppelin/openzeppelin-contracts --no-commit`, {
      encoding: "utf8",
      stdio: "pipe"
    });

    // Compile and deploy
    const forgeResult = execSync(
      `cd ${tmpDir} && forge create src/AccessCredentialNFT.sol:AccessCredentialNFT ` +
      `--constructor-args "${name}" "${symbol}" ` +
      `--private-key "${deployerKey}" --rpc-url "${rpcUrl}" --json`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const deployResult = JSON.parse(forgeResult);
    const contractAddress = deployResult.deployedTo;

    if (!contractAddress) {
      throw new Error(`Deployment failed: ${JSON.stringify(deployResult)}`);
    }

    console.log(`AccessCredentialNFT deployed to: ${contractAddress}`);
    return contractAddress;
  }
}

/**
 * Update web3-defaults.yaml with the deployed NFT contract address
 */
function updateConfig(nftContractAddress: string, subscriptionContractAddress: string): void {
  console.log("\n--- Updating configuration ---");

  if (!fs.existsSync(WEB3_CONFIG_PATH)) {
    console.log(`Config file not found at ${WEB3_CONFIG_PATH}, skipping update`);
    console.log("Update manually:");
    console.log(`  blockchain.nft_contract: "${nftContractAddress}"`);
    return;
  }

  try {
    const configContent = fs.readFileSync(WEB3_CONFIG_PATH, "utf8");
    const config = yaml.load(configContent) as Web3Config;

    config.blockchain.nft_contract = nftContractAddress;

    // Write back with comments preserved as much as possible
    const updatedContent = yaml.dump(config, {
      lineWidth: -1, // Don't wrap lines
      quotingType: '"',
      forceQuotes: true,
    });

    // Add header comment
    const header = `# Blockhost Web3/Blockchain Configuration
# Updated by deploy script on ${new Date().toISOString()}
#
# Managed by: blockhost-common (template), blockhost-engine (populated)

`;

    fs.writeFileSync(WEB3_CONFIG_PATH, header + updatedContent);
    console.log(`Updated ${WEB3_CONFIG_PATH}`);
    console.log(`  blockchain.nft_contract: "${nftContractAddress}"`);
  } catch (err) {
    console.error(`Failed to update config: ${err}`);
    console.log("Update manually:");
    console.log(`  blockchain.nft_contract: "${nftContractAddress}"`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = deployer.address;
  const rpcUrl = process.env.RPC_URL || "";

  // Get private key for forge deployment
  // Hardhat doesn't expose the private key directly, so we need it from env
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";

  if (!deployerKey) {
    console.error("Error: DEPLOYER_PRIVATE_KEY or PRIVATE_KEY environment variable required");
    process.exit(1);
  }

  if (!rpcUrl) {
    console.error("Error: RPC_URL environment variable required");
    process.exit(1);
  }

  console.log("==============================================");
  console.log("  Blockhost Contract Deployment");
  console.log("==============================================");
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`RPC URL: ${rpcUrl}`);

  const balance = await ethers.provider.getBalance(deployerAddress);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error("\nError: Deployer account has no ETH for gas");
    process.exit(1);
  }

  // ============================================
  // 1. Deploy BlockhostSubscriptions (Hardhat)
  // ============================================
  console.log("\n--- Deploying BlockhostSubscriptions ---");

  const BlockhostSubscriptions = await ethers.getContractFactory("BlockhostSubscriptions");
  const subscriptionContract = await BlockhostSubscriptions.deploy();
  await subscriptionContract.waitForDeployment();
  const subscriptionAddress = await subscriptionContract.getAddress();

  console.log(`BlockhostSubscriptions deployed to: ${subscriptionAddress}`);

  // Set primary stablecoin if provided
  const stablecoinAddress = process.env.SEPOLIA_USDC || process.env.USDC_ADDRESS;
  if (stablecoinAddress) {
    console.log(`Setting primary stablecoin: ${stablecoinAddress}`);
    const tx = await subscriptionContract.setPrimaryStablecoin(stablecoinAddress);
    await tx.wait();
    console.log("Primary stablecoin set successfully");
  }

  // ============================================
  // 2. Deploy AccessCredentialNFT (Forge)
  // ============================================
  const nftAddress = await deployNFTContract(deployerKey, rpcUrl);

  // ============================================
  // 3. Update configuration
  // ============================================
  updateConfig(nftAddress, subscriptionAddress);

  // ============================================
  // Summary
  // ============================================
  console.log("\n==============================================");
  console.log("  Deployment Complete!");
  console.log("==============================================");
  console.log(`BlockhostSubscriptions: ${subscriptionAddress}`);
  console.log(`AccessCredentialNFT:    ${nftAddress}`);
  console.log("");
  console.log("Next steps:");
  console.log("1. Create a subscription plan:");
  console.log(`   npx hardhat run scripts/create-plan.ts --network sepolia`);
  console.log("2. Generate the signup page:");
  console.log(`   blockhost-generate-signup --output /var/www/html/signup.html`);
  console.log("3. Start the monitor service:");
  console.log(`   systemctl enable --now blockhost-monitor`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
