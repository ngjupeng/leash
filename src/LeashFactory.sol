// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {LeashVault} from "./LeashVault.sol";

/// @title LeashFactory
/// @notice Deploys LeashVaults and indexes them by their creator.
contract LeashFactory {
    event VaultCreated(address indexed owner, address indexed vault, bytes32 pqKey);

    mapping(address creator => address[]) internal _vaults;
    address[] public allVaults;

    /// @notice Create a vault owned by the caller. Any USDC sent along becomes its opening balance.
    function createVault(bytes32 pqKey, uint64 recoveryDelay) external payable returns (LeashVault vault) {
        vault = new LeashVault{value: msg.value}(msg.sender, pqKey, recoveryDelay);
        _vaults[msg.sender].push(address(vault));
        allVaults.push(address(vault));
        emit VaultCreated(msg.sender, address(vault), pqKey);
    }

    function vaultsOf(address creator) external view returns (address[] memory) {
        return _vaults[creator];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
