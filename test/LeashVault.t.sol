// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {LeashFactory} from "../src/LeashFactory.sol";

contract Sink {
    uint256 public calls;

    function ping() external payable {
        calls++;
    }
}

/// @dev Runs under Arc rules (foundry.toml `network = "arc"`), so pqKey signatures are checked by
///      the real SLH-DSA precompile. Signatures come from tools/pq.mjs over ffi.
contract LeashVaultTest is Test {
    // Test-only keys derived from fixed public seeds. Never use them for real funds.
    bytes32 constant PQ_PUB = 0x1111111111111111111111111111111139ea5575b921a021e3cbda41d2fb49e5;
    string constant PQ_SECRET =
        "0x11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111139ea5575b921a021e3cbda41d2fb49e5";
    bytes32 constant OTHER_PUB = 0x222222222222222222222222222222220fd2c19fce993fa6d5c9884433ad85fa;
    string constant OTHER_SECRET =
        "0x2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222220fd2c19fce993fa6d5c9884433ad85fa";

    uint256 constant USDC = 1e18; // native USDC has 18 decimals on Arc
    uint256 constant GAS_PRICE = 20 gwei;

    LeashFactory factory;
    LeashVault vault;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.fee(GAS_PRICE);
        vm.txGasPrice(GAS_PRICE);
        factory = new LeashFactory();
        vm.deal(owner, 100 * USDC);
        vm.prank(owner);
        vault = factory.createVault{value: 50 * USDC}(PQ_PUB, 1 days);
    }

    // ---- helpers --------------------------------------------------------------------------------

    function _sign(string memory secret, bytes32 digest) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "tools/pq.mjs";
        cmd[2] = "sign";
        cmd[3] = secret;
        cmd[4] = vm.toString(digest);
        return vm.ffi(cmd);
    }

    function _guarded(bytes memory call) internal {
        bytes memory sig = _sign(PQ_SECRET, vault.guardDigest(call));
        vm.prank(owner);
        vault.guarded(call, sig);
    }

    function _addAgent(address a, uint128 cap) internal {
        _guarded(abi.encodeCall(LeashVault.setAgent, (a, cap, 0)));
    }

    // ---- creation -------------------------------------------------------------------------------

    function test_FactoryCreatesFundedVault() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.pqKey(), PQ_PUB);
        assertEq(address(vault).balance, 50 * USDC);
        assertEq(factory.vaultsOf(owner)[0], address(vault));
    }

    function test_RejectsShortRecoveryDelay() public {
        vm.expectRevert(LeashVault.BadArgument.selector);
        factory.createVault(PQ_PUB, 59 minutes);
    }

    // ---- tier 3: post-quantum guard -------------------------------------------------------------

    function test_GuardedAddsAgent() public {
        _addAgent(agent, uint128(5 * USDC));
        (uint128 cap,,,, bool active,) = vault.policies(agent);
        assertEq(cap, 5 * USDC);
        assertTrue(active);
        assertEq(vault.pqNonce(), 1);
    }

    function test_GuardRejectsWrongPqKey() public {
        bytes memory call = abi.encodeCall(LeashVault.setAgent, (agent, uint128(5 * USDC), 0));
        bytes memory sig = _sign(OTHER_SECRET, vault.guardDigest(call));
        vm.prank(owner);
        vm.expectRevert(LeashVault.BadPqSignature.selector);
        vault.guarded(call, sig);
    }

    function test_GuardRejectsTamperedCall() public {
        bytes memory signed = abi.encodeCall(LeashVault.setAgent, (agent, uint128(1 * USDC), 0));
        bytes memory sent = abi.encodeCall(LeashVault.setAgent, (agent, uint128(1000 * USDC), 0));
        bytes memory sig = _sign(PQ_SECRET, vault.guardDigest(signed));
        vm.prank(owner);
        vm.expectRevert(LeashVault.BadPqSignature.selector);
        vault.guarded(sent, sig);
    }

    function test_GuardSignatureIsSingleUse() public {
        bytes memory call = abi.encodeCall(LeashVault.setAgent, (agent, uint128(5 * USDC), 0));
        bytes memory sig = _sign(PQ_SECRET, vault.guardDigest(call));
        vm.prank(owner);
        vault.guarded(call, sig);
        vm.prank(owner);
        vm.expectRevert(LeashVault.BadPqSignature.selector);
        vault.guarded(call, sig);
    }

    function test_GuardNeedsClassicalOwnerToo() public {
        bytes memory call = abi.encodeCall(LeashVault.withdraw, (payable(stranger), 50 * USDC));
        bytes memory sig = _sign(PQ_SECRET, vault.guardDigest(call));
        vm.prank(stranger);
        vm.expectRevert(LeashVault.NotOwner.selector);
        vault.guarded(call, sig);
    }

    function test_GuardedFunctionsUnreachableDirectly() public {
        vm.prank(owner);
        vm.expectRevert(LeashVault.NotGuarded.selector);
        vault.setAgent(agent, uint128(5 * USDC), 0);
        vm.prank(owner);
        vm.expectRevert(LeashVault.NotGuarded.selector);
        vault.withdraw(payable(owner), 1);
    }

    function test_GuardedWithdraw() public {
        _guarded(abi.encodeCall(LeashVault.withdraw, (payable(owner), 20 * USDC)));
        assertEq(address(vault).balance, 30 * USDC);
        assertEq(owner.balance, 70 * USDC);
    }

    // ---- tier 1: agents -------------------------------------------------------------------------

    function test_AgentPaysAndGetsGasRefund() public {
        _addAgent(agent, uint128(1 * USDC));
        vm.prank(agent, agent);
        vault.pay(merchant, 0.1e18, "", "coffee");
        assertEq(merchant.balance, 0.1e18);

        uint256 refund = agent.balance;
        assertGt(refund, 0, "gas refunded in USDC");
        (, uint128 spent,,,,) = vault.policies(agent);
        assertEq(spent, 0.1e18 + refund, "cap counts payment plus gas");
        assertEq(vault.remaining(agent), 1 * USDC - spent);
    }

    function test_ReceiptsRecordedNewestFirst() public {
        _addAgent(agent, uint128(5 * USDC));
        for (uint256 i = 1; i <= 70; ++i) {
            vm.prank(agent, agent);
            vault.pay(merchant, i * 1e15, "", bytes32(i));
        }
        assertEq(vault.paymentCount(), 70);
        LeashVault.Receipt[] memory rs = vault.recentPayments(100);
        assertEq(rs.length, 64, "ring keeps the last 64");
        assertEq(rs[0].amount, 70e15);
        assertEq(rs[0].memo, bytes32(uint256(70)));
        assertEq(rs[63].amount, 7e15);
        assertEq(rs[0].agent, agent);
        assertEq(rs[0].to, merchant);
        assertGt(rs[0].gasRefund, 0);
    }

    function test_AgentCannotExceedCap() public {
        _addAgent(agent, uint128(1 * USDC));
        vm.prank(agent, agent);
        vault.pay(merchant, 0.9e18, "", "");
        uint256 room = vault.remaining(agent);
        vm.prank(agent, agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.OverCap.selector, room, 0.2e18));
        vault.pay(merchant, 0.2e18, "", "");
    }

    function test_CapIsAllInEvenAtTheEdge() public {
        _addAgent(agent, uint128(1 * USDC));
        uint256 vaultBefore = address(vault).balance;
        // Spend the whole cap in one payment: the gas refund is clipped to zero room.
        vm.prank(agent, agent);
        vault.pay(merchant, 1 * USDC, "", "");
        assertEq(vaultBefore - address(vault).balance, 1 * USDC);
        assertEq(vault.remaining(agent), 0);
    }

    /// forge-config: default.fuzz.runs = 24
    function testFuzz_VaultLossNeverExceedsCap(uint96[6] memory amounts) public {
        uint128 cap = uint128(2 * USDC);
        _addAgent(agent, cap);
        uint256 before = address(vault).balance;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amt = uint256(amounts[i]) % (USDC / 2);
            vm.prank(agent, agent);
            try vault.pay(merchant, amt, "", "") {} catch {}
        }
        assertLe(before - address(vault).balance, cap);
    }

    function test_WindowResetsAfterADay() public {
        _addAgent(agent, uint128(1 * USDC));
        vm.prank(agent, agent);
        vault.pay(merchant, 0.9e18, "", "");
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.remaining(agent), 1 * USDC);
        vm.prank(agent, agent);
        vault.pay(merchant, 0.9e18, "", "");
    }

    function test_StrangerCannotPay() public {
        vm.prank(stranger);
        vm.expectRevert(LeashVault.NotAgent.selector);
        vault.pay(merchant, 1, "", "");
    }

    function test_ExpiredAgentCannotPay() public {
        _guarded(abi.encodeCall(LeashVault.setAgent, (agent, uint128(1 * USDC), uint64(block.timestamp + 1 hours))));
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent, agent);
        vm.expectRevert(LeashVault.AgentExpired.selector);
        vault.pay(merchant, 1, "", "");
    }

    function test_AgentCannotTouchUsdcErc20OrVault() public {
        _addAgent(agent, uint128(1 * USDC));
        vm.startPrank(agent, agent);
        vm.expectRevert(LeashVault.BadPayee.selector);
        vault.pay(0x3600000000000000000000000000000000000000, 0, abi.encodeWithSignature("transfer(address,uint256)", agent, 1e6), "");
        vm.expectRevert(LeashVault.BadPayee.selector);
        vault.pay(address(vault), 0, "", "");
        vm.stopPrank();
    }

    function test_CalldataOnlyToAllowlistedPayee() public {
        Sink sink = new Sink();
        _addAgent(agent, uint128(1 * USDC));
        bytes memory ping = abi.encodeCall(Sink.ping, ());

        vm.prank(agent, agent);
        vm.expectRevert(LeashVault.PayeeNotAllowed.selector);
        vault.pay(address(sink), 0.01e18, ping, "");

        _guarded(abi.encodeCall(LeashVault.setPayee, (address(sink), true)));
        vm.prank(agent, agent);
        vault.pay(address(sink), 0.01e18, ping, "api-call");
        assertEq(sink.calls(), 1);
        assertEq(address(sink).balance, 0.01e18);
    }

    function test_PayeeAllowlistMode() public {
        _addAgent(agent, uint128(1 * USDC));
        _guarded(abi.encodeCall(LeashVault.setPayeeAllowlist, (true)));
        vm.prank(agent, agent);
        vm.expectRevert(LeashVault.PayeeNotAllowed.selector);
        vault.pay(merchant, 1, "", "");
    }

    // ---- tier 2: owner reduces risk with a classical key ------------------------------------------

    function test_FreezeIsClassicalUnfreezeIsPostQuantum() public {
        _addAgent(agent, uint128(1 * USDC));
        vm.prank(owner);
        vault.freeze();

        vm.prank(agent, agent);
        vm.expectRevert(LeashVault.VaultFrozen.selector);
        vault.pay(merchant, 1, "", "");

        vm.prank(owner);
        vm.expectRevert(LeashVault.NotGuarded.selector);
        vault.unfreeze();

        _guarded(abi.encodeCall(LeashVault.unfreeze, ()));
        vm.prank(agent, agent);
        vault.pay(merchant, 1, "", "");
    }

    function test_LowerCapOnlyLowers() public {
        _addAgent(agent, uint128(1 * USDC));
        vm.startPrank(owner);
        vm.expectRevert(LeashVault.BadArgument.selector);
        vault.lowerCap(agent, uint128(2 * USDC));
        vault.lowerCap(agent, uint128(0.5e18));
        vm.stopPrank();
        assertEq(vault.remaining(agent), 0.5e18);
    }

    function test_RevokeAgent() public {
        _addAgent(agent, uint128(1 * USDC));
        vm.prank(owner);
        vault.revokeAgent(agent);
        vm.prank(agent, agent);
        vm.expectRevert(LeashVault.NotAgent.selector);
        vault.pay(merchant, 1, "", "");
    }

    // ---- recovery --------------------------------------------------------------------------------

    function test_PqRecoveryRelayedByAnyone() public {
        address newOwner = makeAddr("newOwner");
        bytes memory sig = _sign(PQ_SECRET, vault.recoveryDigest(newOwner));
        vm.prank(stranger);
        vault.startRecovery(newOwner, sig);
        assertTrue(vault.frozen());

        vm.expectRevert(abi.encodeWithSelector(LeashVault.RecoveryNotReady.selector, uint64(block.timestamp + 1 days)));
        vault.finishRecovery();

        vm.warp(block.timestamp + 1 days);
        vault.finishRecovery();
        assertEq(vault.owner(), newOwner);
    }

    function test_OwnerCancelsRecovery() public {
        address attacker = makeAddr("attacker");
        bytes memory sig = _sign(PQ_SECRET, vault.recoveryDigest(attacker));
        vault.startRecovery(attacker, sig);
        vm.prank(owner);
        vault.cancelRecovery();
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(LeashVault.NoRecovery.selector);
        vault.finishRecovery();
        assertEq(vault.owner(), owner);
    }

    function test_RecoveryRejectsWrongKey() public {
        bytes memory sig = _sign(OTHER_SECRET, vault.recoveryDigest(stranger));
        vm.expectRevert(LeashVault.BadPqSignature.selector);
        vault.startRecovery(stranger, sig);
    }

    function test_RotatePqKey() public {
        _guarded(abi.encodeCall(LeashVault.rotatePqKey, (OTHER_PUB)));
        assertEq(vault.pqKey(), OTHER_PUB);
        // The old key no longer works, the new one does.
        bytes memory call = abi.encodeCall(LeashVault.unfreeze, ());
        bytes memory oldSig = _sign(PQ_SECRET, vault.guardDigest(call));
        vm.prank(owner);
        vm.expectRevert(LeashVault.BadPqSignature.selector);
        vault.guarded(call, oldSig);
        bytes memory newSig = _sign(OTHER_SECRET, vault.guardDigest(call));
        vm.prank(owner);
        vault.guarded(call, newSig);
    }
}
