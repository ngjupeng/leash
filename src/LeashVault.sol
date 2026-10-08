// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPQ} from "./IPQ.sol";

/// @title LeashVault
/// @notice A USDC vault on Arc that lets AI agents spend under hard daily dollar caps, gas included.
///
///         Three tiers of authority:
///         1. Agent (classical key):  pay() within its policy. The vault refunds the agent's gas in the
///            same USDC and counts it against the cap, so the cap is the agent's true all-in cost.
///         2. Owner (classical key):  anything that lowers risk. Freeze, revoke, lower a cap, drop a payee.
///         3. Owner + post-quantum key: anything that raises risk. Add or raise an agent, withdraw,
///            unfreeze, change payees, rotate keys. The owner's transaction must carry an
///            SLH-DSA-SHA2-128s signature from a cold key, verified by Arc's PQ precompile.
///
///         The post-quantum key alone can also start a timelocked recovery to a new owner, which the
///         current owner can cancel while it is pending.
contract LeashVault {
    IPQ internal constant PQ = IPQ(0x1800000000000000000000000000000000000004);
    /// @dev ERC-20 view of the native USDC balance. Agents must never call it, since a transfer
    ///      through it would move USDC without passing the value accounting in pay().
    address internal constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;

    bytes32 public constant GUARD_TYPEHASH =
        keccak256("Leash.Guarded(uint256 chainId,address vault,uint256 nonce,bytes32 callHash)");
    bytes32 public constant RECOVERY_TYPEHASH =
        keccak256("Leash.Recovery(uint256 chainId,address vault,uint256 nonce,address newOwner)");

    uint256 public constant WINDOW = 1 days;
    /// @dev Payments kept on-chain for the activity feed. Arc's RPC caps eth_getLogs at a few thousand
    ///      blocks (minutes of history), and gas is priced in cents, so storing receipts is the cheap path.
    uint256 public constant RECEIPTS = 64;
    uint64 public constant MIN_RECOVERY_DELAY = 1 hours;
    /// @dev Gas the agent pays outside the metered part of pay(): intrinsic cost, calldata, the
    ///      refund transfer and the Paid event. Calibrated against Arc mainnet receipts.
    uint256 public constant GAS_OVERHEAD = 34_200;

    struct Policy {
        uint128 dailyCap; // USDC, 18 decimals
        uint128 spent; // spent in the current window, gas refunds included
        uint64 windowStart;
        uint64 expiresAt; // 0 means no expiry
        bool active;
        bool listed;
    }

    /// @dev One payment in the on-chain activity ring. Packed into four slots.
    struct Receipt {
        address agent;
        uint96 gasRefund;
        address to;
        uint40 time;
        uint56 blockNumber;
        uint256 amount;
        bytes32 memo;
    }

    struct AgentView {
        address agent;
        uint128 dailyCap;
        uint128 spent;
        uint128 remaining;
        uint64 windowStart;
        uint64 expiresAt;
        bool active;
    }

    address public owner;
    bytes32 public pqKey;
    uint256 public pqNonce;
    bool public frozen;
    bool public payeeAllowlistOn;
    uint64 public recoveryDelay;
    uint64 public recoveryReadyAt;
    address public pendingOwner;
    uint256 public immutable createdBlock;

    mapping(address agent => Policy) public policies;
    mapping(address payee => bool) public payees;
    address[] internal _agents;
    Receipt[RECEIPTS] internal _receipts;
    uint256 public paymentCount;

    bool transient _locked;
    bool transient _inGuard;

    event Deposited(address indexed from, uint256 amount);
    event Paid(address indexed agent, address indexed to, uint256 amount, uint256 gasRefund, bytes32 memo);
    event AgentSet(address indexed agent, uint128 dailyCap, uint64 expiresAt);
    event AgentRevoked(address indexed agent);
    event CapLowered(address indexed agent, uint128 dailyCap);
    event PayeeSet(address indexed payee, bool allowed);
    event PayeeAllowlist(bool on);
    event Withdrawn(address indexed to, uint256 amount);
    event FrozenSet(bool frozen);
    event Guarded(uint256 indexed nonce, bytes4 indexed selector);
    event PqKeyRotated(bytes32 pqKey);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event RecoveryDelaySet(uint64 delay);
    event RecoveryStarted(address indexed newOwner, uint64 readyAt);
    event RecoveryCancelled(address indexed newOwner);

    error NotOwner();
    error NotGuarded();
    error NotAgent();
    error AgentExpired();
    error VaultFrozen();
    error Reentrancy();
    error BadPayee();
    error PayeeNotAllowed();
    error OverCap(uint256 remaining, uint256 requested);
    error CallFailed(bytes reason);
    error BadPqSignature();
    error BadArgument();
    error NoRecovery();
    error RecoveryNotReady(uint64 readyAt);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Only reachable through guarded(), after the post-quantum signature has been checked.
    modifier onlyGuarded() {
        if (msg.sender != address(this) || !_inGuard) revert NotGuarded();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address owner_, bytes32 pqKey_, uint64 recoveryDelay_) payable {
        if (owner_ == address(0) || pqKey_ == bytes32(0) || recoveryDelay_ < MIN_RECOVERY_DELAY) {
            revert BadArgument();
        }
        owner = owner_;
        pqKey = pqKey_;
        recoveryDelay = recoveryDelay_;
        createdBlock = block.number;
        emit OwnerChanged(address(0), owner_);
        emit PqKeyRotated(pqKey_);
        emit RecoveryDelaySet(recoveryDelay_);
        if (msg.value > 0) emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------------------------------
    // Tier 1: agents
    // ---------------------------------------------------------------------------------------------

    /// @notice Pay `amount` USDC to `to`, optionally calling it with `data`. Calldata is only allowed
    ///         for allowlisted payees. The agent's gas for this call is refunded in USDC and counted
    ///         against its daily cap, so the cap bounds everything the agent can cost the vault.
    function pay(address to, uint256 amount, bytes calldata data, bytes32 memo)
        external
        nonReentrant
        returns (bytes memory result)
    {
        uint256 gasStart = gasleft();
        if (frozen) revert VaultFrozen();
        Policy storage p = policies[msg.sender];
        if (!p.active) revert NotAgent();
        if (p.expiresAt != 0 && block.timestamp > p.expiresAt) revert AgentExpired();
        if (to == address(this) || to == USDC_ERC20 || to == address(0)) revert BadPayee();
        if ((payeeAllowlistOn || data.length != 0) && !payees[to]) revert PayeeNotAllowed();

        _roll(p);
        uint256 room = p.dailyCap - p.spent;
        if (amount > room) revert OverCap(room, amount);
        p.spent += uint128(amount);

        bool ok;
        (ok, result) = to.call{value: amount}(data);
        if (!ok) revert CallFailed(result);

        // Write the receipt inside the metered region so its storage cost is refunded too. Only the
        // gasRefund field is patched afterwards, which touches an already-dirty slot.
        Receipt storage r = _receipts[paymentCount++ % RECEIPTS];
        r.agent = msg.sender;
        r.to = to;
        r.time = uint40(block.timestamp);
        r.blockNumber = uint56(block.number);
        r.amount = amount;
        r.memo = memo;

        uint256 refund = _refundGas(p, gasStart);
        r.gasRefund = uint96(refund);
        emit Paid(msg.sender, to, amount, refund, memo);
    }

    function _refundGas(Policy storage p, uint256 gasStart) internal returns (uint256 refund) {
        uint256 price = tx.gasprice;
        uint256 ceiling = block.basefee * 2;
        if (price > ceiling) price = ceiling;
        refund = (gasStart - gasleft() + GAS_OVERHEAD) * price;

        uint256 room = p.dailyCap - p.spent;
        if (refund > room) refund = room;
        if (refund > address(this).balance) refund = address(this).balance;
        if (refund == 0) return 0;

        p.spent += uint128(refund);
        (bool ok, bytes memory reason) = msg.sender.call{value: refund}("");
        if (!ok) revert CallFailed(reason);
    }

    function _roll(Policy storage p) internal {
        if (block.timestamp >= uint256(p.windowStart) + WINDOW) {
            p.windowStart = uint64(block.timestamp);
            p.spent = 0;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Tier 2: owner, risk-reducing only
    // ---------------------------------------------------------------------------------------------

    function freeze() external onlyOwner {
        frozen = true;
        emit FrozenSet(true);
    }

    function revokeAgent(address agent) external onlyOwner {
        Policy storage p = policies[agent];
        if (!p.active) revert NotAgent();
        p.active = false;
        emit AgentRevoked(agent);
    }

    function lowerCap(address agent, uint128 dailyCap) external onlyOwner {
        Policy storage p = policies[agent];
        if (!p.active || dailyCap >= p.dailyCap) revert BadArgument();
        p.dailyCap = dailyCap;
        if (p.spent > dailyCap) p.spent = dailyCap;
        emit CapLowered(agent, dailyCap);
    }

    function removePayee(address payee) external onlyOwner {
        payees[payee] = false;
        emit PayeeSet(payee, false);
    }

    function cancelRecovery() external onlyOwner {
        address pending = pendingOwner;
        if (pending == address(0)) revert NoRecovery();
        pendingOwner = address(0);
        recoveryReadyAt = 0;
        emit RecoveryCancelled(pending);
    }

    // ---------------------------------------------------------------------------------------------
    // Tier 3: owner + post-quantum signature
    // ---------------------------------------------------------------------------------------------

    /// @notice Run one risk-increasing call on this vault. `pqSig` must be an SLH-DSA-SHA2-128s
    ///         signature by `pqKey` over guardDigest(call). The nonce makes each signature single use.
    function guarded(bytes calldata call, bytes calldata pqSig) external onlyOwner nonReentrant returns (bytes memory) {
        uint256 nonce = pqNonce;
        _verifyPq(guardDigest(call), pqSig);
        pqNonce = nonce + 1;

        _inGuard = true;
        (bool ok, bytes memory ret) = address(this).call(call);
        _inGuard = false;
        if (!ok) revert CallFailed(ret);

        emit Guarded(nonce, bytes4(call[:4]));
        return ret;
    }

    function setAgent(address agent, uint128 dailyCap, uint64 expiresAt) external onlyGuarded {
        if (agent == address(0) || agent == address(this) || dailyCap == 0) revert BadArgument();
        Policy storage p = policies[agent];
        if (!p.listed) {
            p.listed = true;
            _agents.push(agent);
        }
        if (!p.active) {
            p.windowStart = uint64(block.timestamp);
            p.spent = 0;
        }
        p.dailyCap = dailyCap;
        p.expiresAt = expiresAt;
        p.active = true;
        emit AgentSet(agent, dailyCap, expiresAt);
    }

    function withdraw(address payable to, uint256 amount) external onlyGuarded {
        if (to == address(0)) revert BadArgument();
        (bool ok, bytes memory reason) = to.call{value: amount}("");
        if (!ok) revert CallFailed(reason);
        emit Withdrawn(to, amount);
    }

    function unfreeze() external onlyGuarded {
        frozen = false;
        emit FrozenSet(false);
    }

    function setPayee(address payee, bool allowed) external onlyGuarded {
        if (payee == address(this) || payee == USDC_ERC20 || payee == address(0)) revert BadPayee();
        payees[payee] = allowed;
        emit PayeeSet(payee, allowed);
    }

    function setPayeeAllowlist(bool on) external onlyGuarded {
        payeeAllowlistOn = on;
        emit PayeeAllowlist(on);
    }

    function rotatePqKey(bytes32 newKey) external onlyGuarded {
        if (newKey == bytes32(0)) revert BadArgument();
        pqKey = newKey;
        emit PqKeyRotated(newKey);
    }

    function transferOwnership(address newOwner) external onlyGuarded {
        if (newOwner == address(0)) revert BadArgument();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function setRecoveryDelay(uint64 delay) external onlyGuarded {
        if (delay < MIN_RECOVERY_DELAY) revert BadArgument();
        recoveryDelay = delay;
        emit RecoveryDelaySet(delay);
    }

    // ---------------------------------------------------------------------------------------------
    // Recovery: post-quantum key alone, timelocked, cancellable by the owner
    // ---------------------------------------------------------------------------------------------

    /// @notice Anyone may relay this. The signer of `pqSig` never needs an Arc account.
    ///         Starting a recovery freezes agent spending until it finishes or is cancelled.
    function startRecovery(address newOwner, bytes calldata pqSig) external nonReentrant {
        if (newOwner == address(0)) revert BadArgument();
        uint256 nonce = pqNonce;
        _verifyPq(recoveryDigest(newOwner), pqSig);
        pqNonce = nonce + 1;

        uint64 readyAt = uint64(block.timestamp) + recoveryDelay;
        pendingOwner = newOwner;
        recoveryReadyAt = readyAt;
        frozen = true;
        emit FrozenSet(true);
        emit RecoveryStarted(newOwner, readyAt);
    }

    function finishRecovery() external {
        address pending = pendingOwner;
        if (pending == address(0)) revert NoRecovery();
        if (block.timestamp < recoveryReadyAt) revert RecoveryNotReady(recoveryReadyAt);
        pendingOwner = address(0);
        recoveryReadyAt = 0;
        emit OwnerChanged(owner, pending);
        owner = pending;
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function guardDigest(bytes calldata call) public view returns (bytes32) {
        return keccak256(abi.encode(GUARD_TYPEHASH, block.chainid, address(this), pqNonce, keccak256(call)));
    }

    function recoveryDigest(address newOwner) public view returns (bytes32) {
        return keccak256(abi.encode(RECOVERY_TYPEHASH, block.chainid, address(this), pqNonce, newOwner));
    }

    function remaining(address agent) public view returns (uint256) {
        Policy storage p = policies[agent];
        if (!p.active || (p.expiresAt != 0 && block.timestamp > p.expiresAt)) return 0;
        if (block.timestamp >= uint256(p.windowStart) + WINDOW) return p.dailyCap;
        return p.dailyCap - p.spent;
    }

    /// @notice Most recent payments first, up to `n` (at most RECEIPTS).
    function recentPayments(uint256 n) external view returns (Receipt[] memory out) {
        uint256 count = paymentCount;
        if (n > count) n = count;
        if (n > RECEIPTS) n = RECEIPTS;
        out = new Receipt[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _receipts[(count - 1 - i) % RECEIPTS];
        }
    }

    function agentCount() external view returns (uint256) {
        return _agents.length;
    }

    function agents() external view returns (AgentView[] memory out) {
        uint256 n = _agents.length;
        out = new AgentView[](n);
        for (uint256 i; i < n; ++i) {
            address a = _agents[i];
            Policy storage p = policies[a];
            bool rolled = block.timestamp >= uint256(p.windowStart) + WINDOW;
            out[i] = AgentView({
                agent: a,
                dailyCap: p.dailyCap,
                spent: rolled ? 0 : p.spent,
                remaining: uint128(remaining(a)),
                windowStart: p.windowStart,
                expiresAt: p.expiresAt,
                active: p.active
            });
        }
    }

    function _verifyPq(bytes32 digest, bytes calldata sig) internal view {
        if (!PQ.verifySlhDsaSha2128s(abi.encodePacked(pqKey), abi.encodePacked(digest), sig)) {
            revert BadPqSignature();
        }
    }
}
