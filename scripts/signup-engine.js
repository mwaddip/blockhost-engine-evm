// Signup page engine — wallet connection, signing, purchase, and decrypt logic.
// Self-initializes when the module loads (after DOM is parsed).

import { secp256k1 } from 'https://esm.run/@noble/curves@1.4.0/secp256k1';
import { hkdf } from 'https://esm.run/@noble/hashes@1.4.0/hkdf';
import { sha256 } from 'https://esm.run/@noble/hashes@1.4.0/sha256';
import { randomBytes } from 'https://esm.run/@noble/hashes@1.4.0/utils';

// ---------------------------------------------------------------------------
// ECIES encryption (secp256k1 + AES-GCM)
// ---------------------------------------------------------------------------

var ECIES = {
    hexToBytes: function(hex) {
        hex = hex.startsWith('0x') ? hex.slice(2) : hex;
        var bytes = new Uint8Array(hex.length / 2);
        for (var i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return bytes;
    },

    bytesToHex: function(bytes) {
        return Array.from(bytes).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    },

    encrypt: async function(publicKeyHex, plaintext) {
        var serverPubKeyBytes = this.hexToBytes(publicKeyHex);
        var ephemeralPrivKey = randomBytes(32);
        var ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, false);
        var sharedPoint = secp256k1.getSharedSecret(ephemeralPrivKey, serverPubKeyBytes, false);
        var sharedX = sharedPoint.slice(1, 33);
        var encryptionKey = hkdf(sha256, sharedX, new Uint8Array(0), new Uint8Array(0), 32);
        var iv = randomBytes(12);
        var cryptoKey = await crypto.subtle.importKey('raw', encryptionKey, { name: 'AES-GCM' }, false, ['encrypt']);
        var plaintextBytes = new TextEncoder().encode(plaintext);
        var ciphertextWithTag = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, cryptoKey, plaintextBytes);
        var result = new Uint8Array(ephemeralPubKey.length + iv.length + ciphertextWithTag.byteLength);
        result.set(ephemeralPubKey, 0);
        result.set(iv, ephemeralPubKey.length);
        result.set(new Uint8Array(ciphertextWithTag), ephemeralPubKey.length + iv.length);
        return '0x' + this.bytesToHex(result);
    }
};

// ---------------------------------------------------------------------------
// Keccak256 (for deriving decryption key from signature)
// ---------------------------------------------------------------------------

function keccak256(input) {
    var RC = [1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n,
        0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
        0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
        0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
        0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
    var ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
    var PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
    var rotl = function(x, n) { return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & 0xffffffffffffffffn; };

    function keccakF(s) {
        for (var r = 0; r < 24; r++) {
            var c = [0n, 0n, 0n, 0n, 0n];
            for (var x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
            for (var x = 0; x < 5; x++) { var t = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1); for (var y = 0; y < 25; y += 5) s[x + y] ^= t; }
            var t = s[1]; for (var i = 0; i < 24; i++) { var j = PI[i]; var tmp = s[j]; s[j] = rotl(t, ROTC[i]); t = tmp; }
            for (var y = 0; y < 25; y += 5) { var t0 = s[y], t1 = s[y + 1]; s[y] ^= (~t1) & s[y + 2]; s[y + 1] ^= (~s[y + 2]) & s[y + 3]; s[y + 2] ^= (~s[y + 3]) & s[y + 4]; s[y + 3] ^= (~s[y + 4]) & t0; s[y + 4] ^= (~t0) & t1; }
            s[0] ^= RC[r];
        }
    }

    var msg;
    if (input.startsWith('0x')) {
        input = input.slice(2);
        msg = new Uint8Array(input.length / 2);
        for (var i = 0; i < input.length; i += 2) msg[i / 2] = parseInt(input.substr(i, 2), 16);
    } else {
        msg = new TextEncoder().encode(input);
    }

    var rate = 136;
    var padded = new Uint8Array(Math.ceil((msg.length + 1) / rate) * rate);
    padded.set(msg);
    padded[msg.length] = 0x01;
    padded[padded.length - 1] |= 0x80;

    var s = new Array(25).fill(0n);
    for (var i = 0; i < padded.length; i += rate) {
        for (var j = 0; j < rate / 8; j++) {
            var v = 0n;
            for (var k = 0; k < 8; k++) v |= BigInt(padded[i + j * 8 + k]) << BigInt(k * 8);
            s[j] ^= v;
        }
        keccakF(s);
    }

    var out = new Uint8Array(32);
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 8; j++) {
            out[i * 8 + j] = Number((s[i] >> BigInt(j * 8)) & 0xffn);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// AES-GCM decryption
// ---------------------------------------------------------------------------

async function decryptAesGcm(keyBytes, ciphertextHex) {
    ciphertextHex = ciphertextHex.replace(/^0x/, '');
    var data = new Uint8Array(ciphertextHex.length / 2);
    for (var i = 0; i < ciphertextHex.length; i += 2) data[i / 2] = parseInt(ciphertextHex.substr(i, 2), 16);

    var nonce = data.slice(0, 12);
    var ciphertext = data.slice(12);

    var key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    var decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
}

// ---------------------------------------------------------------------------
// Contract ABIs
// ---------------------------------------------------------------------------

var SUBSCRIPTION_ABI = [
    'function buySubscription(uint256 planId, uint256 days, uint256 paymentMethodId, bytes userEncrypted) external returns (uint256)',
    'function getPlan(uint256 planId) view returns (string name, uint256 pricePerDayUsdCents, bool active)',
    'function getTotalPlanCount() view returns (uint256)',
    'function calculatePayment(uint256 planId, uint256 days, uint256 paymentMethodId) view returns (uint256)',
];

var ERC20_ABI = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

var NFT_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function getUserEncrypted(uint256 tokenId) view returns (bytes)',
    'function ownerOf(uint256 tokenId) view returns (address)',
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var CONFIG = window.CONFIG;
var provider = null;
var signer = null;
var userAddress = null;
var userSignature = null;
var encryptedSignature = null;
var plans = [];
var userNfts = [];
var selectedNft = null;
var offlineNftData = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showStatus(element, message, type) {
    type = type || 'info';
    element.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
}

function updateStep(stepEl, status) {
    var numEl = stepEl.querySelector('.step-number');
    if (!numEl) return;
    stepEl.classList.remove('completed', 'error');
    numEl.classList.remove('done', 'error');
    if (status === 'done') {
        stepEl.classList.add('completed');
        numEl.classList.add('done');
        numEl.textContent = '\u2713';
    } else if (status === 'error') {
        stepEl.classList.add('error');
        numEl.classList.add('error');
        numEl.textContent = '!';
    }
}

function switchTab(tab) {
    document.getElementById('tab-wallet').classList.toggle('active', tab === 'wallet');
    document.getElementById('tab-offline').classList.toggle('active', tab === 'offline');
    document.getElementById('mode-wallet').classList.toggle('hidden', tab !== 'wallet');
    document.getElementById('mode-offline').classList.toggle('hidden', tab !== 'offline');
}

// ---------------------------------------------------------------------------
// Load plans from contract
// ---------------------------------------------------------------------------

async function loadPlans() {
    var planSelect = document.getElementById('plan-select');
    if (!CONFIG.subscriptionContract) {
        console.warn('Subscription contract not configured');
        return;
    }

    try {
        var readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
        var contract = new ethers.Contract(CONFIG.subscriptionContract, SUBSCRIPTION_ABI, readProvider);
        var totalPlans = await contract.getTotalPlanCount();
        console.log('Total plans:', totalPlans.toString());

        plans = [];
        planSelect.innerHTML = '';

        for (var i = 1; i <= totalPlans; i++) {
            try {
                var result = await contract.getPlan(i);
                var name = result[0], pricePerDayUsdCents = result[1], active = result[2];
                if (active) {
                    var pricePerDay = Number(pricePerDayUsdCents) / 100;
                    plans.push({ id: i, name: name, pricePerDay: pricePerDay });
                    var option = document.createElement('option');
                    option.value = i;
                    option.textContent = name + ' - $' + pricePerDay.toFixed(2) + '/day';
                    planSelect.appendChild(option);
                }
            } catch (e) {
                console.warn('Error loading plan ' + i + ':', e);
            }
        }

        if (plans.length === 0) {
            planSelect.innerHTML = '<option value="">No plans available</option>';
        }
    } catch (err) {
        console.error('Error loading plans:', err);
        planSelect.innerHTML = '<option value="">Error loading plans</option>';
    }
}

// ---------------------------------------------------------------------------
// Load user's NFTs
// ---------------------------------------------------------------------------

async function loadUserNfts() {
    if (!CONFIG.nftContract || !userAddress) {
        console.warn('NFT contract not configured or wallet not connected');
        return;
    }

    document.getElementById('servers-not-connected').classList.add('hidden');
    document.getElementById('servers-loading').classList.remove('hidden');
    document.getElementById('server-list').classList.add('hidden');
    document.getElementById('servers-empty').classList.add('hidden');
    document.getElementById('servers-decrypt').classList.add('hidden');
    document.getElementById('connection-result').classList.add('hidden');

    try {
        var readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
        var nftContract = new ethers.Contract(CONFIG.nftContract, NFT_ABI, readProvider);

        var balance = await nftContract.balanceOf(userAddress);
        console.log('NFT balance:', balance.toString());

        userNfts = [];
        for (var i = 0; i < balance; i++) {
            try {
                var tokenId = await nftContract.tokenOfOwnerByIndex(userAddress, i);
                var userEncrypted = await nftContract.getUserEncrypted(tokenId);
                userNfts.push({
                    tokenId: tokenId.toString(),
                    userEncrypted: userEncrypted.startsWith('0x') ? userEncrypted : '0x' + Array.from(userEncrypted).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''),
                });
            } catch (e) {
                console.warn('Error loading token at index ' + i + ':', e);
            }
        }

        document.getElementById('servers-loading').classList.add('hidden');

        if (userNfts.length === 0) {
            document.getElementById('servers-empty').classList.remove('hidden');
        } else {
            renderNftList();
            document.getElementById('server-list').classList.remove('hidden');
        }
    } catch (err) {
        console.error('Error loading NFTs:', err);
        document.getElementById('servers-loading').classList.add('hidden');
        document.getElementById('servers-empty').classList.remove('hidden');
    }
}

// ---------------------------------------------------------------------------
// Render NFT list
// ---------------------------------------------------------------------------

function renderNftList() {
    var container = document.getElementById('server-list');
    container.innerHTML = '';

    userNfts.forEach(function(nft, index) {
        var card = document.createElement('div');
        card.className = 'server-card' + (index === 0 ? ' selected' : '');
        card.innerHTML =
            '<div class="server-card-header">' +
                '<span class="server-card-title">Server</span>' +
                '<span class="server-card-id">Token #' + nft.tokenId + '</span>' +
            '</div>';
        card.onclick = function() { selectNft(index); };
        container.appendChild(card);
    });

    if (userNfts.length > 0) {
        selectNft(0);
    }
}

function selectNft(index) {
    selectedNft = userNfts[index];
    document.querySelectorAll('.server-card').forEach(function(card, i) {
        card.classList.toggle('selected', i === index);
    });
    document.getElementById('servers-decrypt').classList.remove('hidden');
    document.getElementById('connection-result').classList.add('hidden');
    document.getElementById('decrypt-wallet-status').innerHTML = '';
}

// ---------------------------------------------------------------------------
// Update cost calculation
// ---------------------------------------------------------------------------

function updateCost() {
    var planSelect = document.getElementById('plan-select');
    var daysInput = document.getElementById('days-input');
    var totalCostEl = document.getElementById('total-cost');
    var planId = parseInt(planSelect.value);
    var days = parseInt(daysInput.value) || 30;
    var plan = plans.find(function(p) { return p.id === planId; });
    if (plan) {
        var total = days * plan.pricePerDay;
        totalCostEl.textContent = '$' + total.toFixed(2) + ' USDC';
    } else {
        totalCostEl.textContent = '-';
    }
}

// ---------------------------------------------------------------------------
// Initialize — attach event listeners
// ---------------------------------------------------------------------------

// Tab switching
document.getElementById('tab-wallet').addEventListener('click', function() { switchTab('wallet'); });
document.getElementById('tab-offline').addEventListener('click', function() { switchTab('offline'); });

// Offline lookup type
document.getElementById('offline-lookup-type').addEventListener('change', function(e) {
    document.getElementById('offline-tokenid-group').classList.toggle('hidden', e.target.value !== 'tokenId');
    document.getElementById('offline-address-group').classList.toggle('hidden', e.target.value !== 'address');
});

// Cost updates
document.getElementById('days-input').addEventListener('input', updateCost);
document.getElementById('plan-select').addEventListener('change', updateCost);

// Step 1: Connect Wallet
document.getElementById('btn-connect').addEventListener('click', async function() {
    var btnConnect = document.getElementById('btn-connect');
    var stepConnect = document.getElementById('step-connect');
    var statusMessage = document.getElementById('status-message');
    try {
        btnConnect.disabled = true;
        btnConnect.classList.add('loading');
        btnConnect.textContent = 'Connecting...';

        if (!window.ethereum) {
            throw new Error('No wallet found. Please install MetaMask.');
        }

        provider = new ethers.BrowserProvider(window.ethereum);
        await provider.send('eth_requestAccounts', []);
        signer = await provider.getSigner();
        userAddress = await signer.getAddress();

        var network = await provider.getNetwork();
        if (Number(network.chainId) !== CONFIG.chainId) {
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: '0x' + CONFIG.chainId.toString(16) }],
                });
                provider = new ethers.BrowserProvider(window.ethereum);
                signer = await provider.getSigner();
            } catch (e) {
                throw new Error('Please switch to chain ID ' + CONFIG.chainId);
            }
        }

        document.getElementById('wallet-not-connected').classList.add('hidden');
        document.getElementById('wallet-connected').classList.remove('hidden');
        document.getElementById('wallet-address').textContent = userAddress;
        updateStep(stepConnect, 'done');
        document.getElementById('btn-sign').disabled = false;

        loadUserNfts();

        document.getElementById('admin-not-connected').classList.add('hidden');
        document.getElementById('admin-connected').classList.remove('hidden');

    } catch (err) {
        showStatus(statusMessage, err.message, 'error');
        updateStep(stepConnect, 'error');
        btnConnect.disabled = false;
        btnConnect.classList.remove('loading');
        btnConnect.textContent = 'Connect Wallet';
    }
});

// Step 2: Sign Message
document.getElementById('btn-sign').addEventListener('click', async function() {
    var btnSign = document.getElementById('btn-sign');
    var stepSign = document.getElementById('step-sign');
    var signatureStatus = document.getElementById('signature-status');
    try {
        btnSign.disabled = true;
        btnSign.classList.add('loading');
        btnSign.textContent = 'Waiting for signature...';

        userSignature = await signer.signMessage(CONFIG.publicSecret);
        showStatus(signatureStatus, 'Encrypting credentials...', 'info');
        encryptedSignature = await ECIES.encrypt(CONFIG.serverPublicKey, userSignature);

        showStatus(signatureStatus, 'Authentication complete!', 'success');
        updateStep(stepSign, 'done');

        document.getElementById('plan-select').disabled = false;
        document.getElementById('days-input').disabled = false;
        document.getElementById('btn-purchase').disabled = false;
        updateCost();

    } catch (err) {
        console.error('Sign error:', err);
        showStatus(signatureStatus, err.message, 'error');
        updateStep(stepSign, 'error');
        btnSign.disabled = false;
        btnSign.classList.remove('loading');
        btnSign.textContent = 'Sign Authentication';
    }
});

// Step 3: Purchase
document.getElementById('btn-purchase').addEventListener('click', async function() {
    var btnPurchase = document.getElementById('btn-purchase');
    var stepPurchase = document.getElementById('step-purchase');
    var purchaseStatus = document.getElementById('purchase-status');
    try {
        btnPurchase.disabled = true;
        btnPurchase.classList.add('loading');
        btnPurchase.textContent = 'Processing...';

        var planId = parseInt(document.getElementById('plan-select').value);
        var days = parseInt(document.getElementById('days-input').value);

        if (!CONFIG.subscriptionContract || !CONFIG.usdcAddress) {
            throw new Error('Contract addresses not configured');
        }

        if (!planId || planId < 1) {
            throw new Error('Please select a plan');
        }

        var subscriptionContract = new ethers.Contract(CONFIG.subscriptionContract, SUBSCRIPTION_ABI, signer);
        var usdc = new ethers.Contract(CONFIG.usdcAddress, ERC20_ABI, signer);

        showStatus(purchaseStatus, 'Calculating payment...', 'info');
        var paymentAmount = await subscriptionContract.calculatePayment(planId, days, 1);

        var balance = await usdc.balanceOf(userAddress);
        if (balance < paymentAmount) {
            throw new Error('Insufficient USDC balance. Need ' + ethers.formatUnits(paymentAmount, 6) + ' USDC');
        }

        var allowance = await usdc.allowance(userAddress, CONFIG.subscriptionContract);
        if (allowance < paymentAmount) {
            showStatus(purchaseStatus, 'Approving USDC spend...', 'info');
            var approveTx = await usdc.approve(CONFIG.subscriptionContract, paymentAmount);
            await approveTx.wait();
        }

        showStatus(purchaseStatus, 'Confirm transaction in wallet...', 'info');
        var tx = await subscriptionContract.buySubscription(planId, days, 1, encryptedSignature);

        showStatus(purchaseStatus, 'Transaction submitted, waiting for confirmation...', 'info');
        var receipt = await tx.wait();

        updateStep(stepPurchase, 'done');
        stepPurchase.classList.add('hidden');
        document.getElementById('result-card').classList.remove('hidden');

        var txLink = document.getElementById('tx-link');
        txLink.href = 'https://sepolia.etherscan.io/tx/' + receipt.hash;
        txLink.textContent = receipt.hash.slice(0, 10) + '...' + receipt.hash.slice(-8);

    } catch (err) {
        console.error(err);
        showStatus(purchaseStatus, err.message || 'Transaction failed', 'error');
        updateStep(stepPurchase, 'error');
        btnPurchase.disabled = false;
        btnPurchase.classList.remove('loading');
        btnPurchase.textContent = 'Purchase Subscription';
    }
});

// Decrypt NFT connection info (wallet mode)
document.getElementById('btn-decrypt-wallet').addEventListener('click', async function() {
    if (!selectedNft || !signer) return;

    var btn = document.getElementById('btn-decrypt-wallet');
    var statusEl = document.getElementById('decrypt-wallet-status');

    try {
        btn.disabled = true;
        btn.classList.add('loading');
        btn.textContent = 'Signing...';

        var userEncrypted = selectedNft.userEncrypted;
        if (!userEncrypted || userEncrypted === '0x') {
            throw new Error('No encrypted data found for this NFT');
        }

        var signature = await signer.signMessage(CONFIG.publicSecret);
        showStatus(statusEl, 'Decrypting...', 'info');
        var keyBytes = keccak256(signature);
        var decrypted = await decryptAesGcm(keyBytes, userEncrypted);

        document.getElementById('connection-info').textContent = decrypted;
        document.getElementById('connection-result').classList.remove('hidden');
        statusEl.innerHTML = '';

    } catch (err) {
        console.error('Decrypt error:', err);
        showStatus(statusEl, err.message || 'Decryption failed', 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = 'Sign to Decrypt Connection Info';
    }
});

// Lookup NFT (offline mode)
document.getElementById('btn-lookup-nft').addEventListener('click', async function() {
    var lookupType = document.getElementById('offline-lookup-type').value;
    var statusEl = document.getElementById('offline-lookup-status');

    if (!CONFIG.nftContract) {
        showStatus(statusEl, 'NFT contract not configured', 'error');
        return;
    }

    try {
        var readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
        var nftContract = new ethers.Contract(CONFIG.nftContract, NFT_ABI, readProvider);

        var tokenId;
        if (lookupType === 'tokenId') {
            tokenId = document.getElementById('offline-token-id').value;
            if (!tokenId) {
                throw new Error('Please enter a token ID');
            }
        } else {
            var address = document.getElementById('offline-address').value;
            if (!address || !ethers.isAddress(address)) {
                throw new Error('Please enter a valid wallet address');
            }
            var bal = await nftContract.balanceOf(address);
            if (bal === 0n) {
                throw new Error('No NFTs found for this address');
            }
            tokenId = await nftContract.tokenOfOwnerByIndex(address, 0);
        }

        showStatus(statusEl, 'Loading NFT data...', 'info');

        var userEncryptedRaw = await nftContract.getUserEncrypted(tokenId);
        var userEncrypted = userEncryptedRaw.startsWith('0x') ? userEncryptedRaw : '0x' + Array.from(userEncryptedRaw).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');

        if (!userEncrypted || userEncrypted === '0x') {
            throw new Error('No encrypted data found for this NFT');
        }

        var publicSecret = CONFIG.publicSecret;

        document.getElementById('offline-public-secret').textContent = publicSecret;
        document.getElementById('offline-encrypted-data').textContent = userEncrypted;
        document.getElementById('offline-cli-instructions').textContent =
            '# Sign with cast (Foundry)\n' +
            'cast wallet sign "' + publicSecret + '" --private-key YOUR_PRIVATE_KEY\n' +
            '\n' +
            '# Or with ethers.js\n' +
            "const wallet = new ethers.Wallet('YOUR_PRIVATE_KEY');\n" +
            "console.log(await wallet.signMessage('" + publicSecret + "'));";

        document.getElementById('offline-nft-info').classList.remove('hidden');
        document.getElementById('offline-connection-result').classList.add('hidden');
        statusEl.innerHTML = '';

        offlineNftData = { publicSecret: publicSecret, userEncrypted: userEncrypted };

    } catch (err) {
        console.error('Lookup error:', err);
        showStatus(statusEl, err.message || 'Lookup failed', 'error');
    }
});

// Decrypt (offline mode)
document.getElementById('btn-decrypt-offline').addEventListener('click', async function() {
    var statusEl = document.getElementById('decrypt-offline-status');
    var signature = document.getElementById('offline-signature').value.trim();

    if (!signature) {
        showStatus(statusEl, 'Please paste your signature', 'error');
        return;
    }

    if (!offlineNftData) {
        showStatus(statusEl, 'Please lookup an NFT first', 'error');
        return;
    }

    try {
        showStatus(statusEl, 'Decrypting...', 'info');
        var keyBytes = keccak256(signature);
        var decrypted = await decryptAesGcm(keyBytes, offlineNftData.userEncrypted);

        document.getElementById('offline-connection-info').textContent = decrypted;
        document.getElementById('offline-connection-result').classList.remove('hidden');
        statusEl.innerHTML = '';

    } catch (err) {
        console.error('Decrypt error:', err);
        showStatus(statusEl, 'Decryption failed. Make sure you signed the correct message with the correct key.', 'error');
    }
});

// Admin Command: Send encrypted command
document.getElementById('btn-send-command').addEventListener('click', async function() {
    var btn = document.getElementById('btn-send-command');
    var statusEl = document.getElementById('command-status');
    var resultEl = document.getElementById('command-result');

    var commandName = document.getElementById('command-name').value.trim();
    var paramsText = document.getElementById('command-params').value.trim();

    if (!commandName) {
        showStatus(statusEl, 'Please enter a command name', 'error');
        return;
    }

    if (!signer) {
        showStatus(statusEl, 'Please connect your wallet first', 'error');
        return;
    }

    try {
        btn.disabled = true;
        btn.classList.add('loading');
        btn.textContent = 'Preparing...';

        var params = {};
        if (paramsText) {
            try {
                params = JSON.parse(paramsText);
            } catch (e) {
                throw new Error('Invalid JSON in parameters');
            }
        }

        var command = {
            command: commandName,
            params: params,
            nonce: crypto.randomUUID(),
            timestamp: Math.floor(Date.now() / 1000)
        };

        showStatus(statusEl, 'Encrypting command...', 'info');

        var plaintext = JSON.stringify(command);
        var ciphertext = await ECIES.encrypt(CONFIG.serverPublicKey, plaintext);

        showStatus(statusEl, 'Confirm transaction in wallet...', 'info');

        var tx = await signer.sendTransaction({
            to: userAddress,
            data: ciphertext,
            value: 0
        });

        showStatus(statusEl, 'Transaction submitted, waiting for confirmation...', 'info');
        var receipt = await tx.wait();

        statusEl.innerHTML = '';
        resultEl.classList.remove('hidden');
        var txLink = document.getElementById('command-tx-link');
        txLink.href = 'https://sepolia.etherscan.io/tx/' + receipt.hash;
        txLink.textContent = receipt.hash.slice(0, 10) + '...' + receipt.hash.slice(-8);

        document.getElementById('command-name').value = '';
        document.getElementById('command-params').value = '';

    } catch (err) {
        console.error('Command error:', err);
        showStatus(statusEl, err.message || 'Failed to send command', 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = 'Encrypt & Send Command';
    }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

console.log('Blockhost Signup Page loaded');
console.log('Config:', Object.assign({}, CONFIG, {
    serverPublicKey: CONFIG.serverPublicKey ? CONFIG.serverPublicKey.slice(0, 20) + '...' : 'NOT SET'
}));

loadPlans();
