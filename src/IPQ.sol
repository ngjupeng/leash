// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Arc's post-quantum signature precompile at 0x1800000000000000000000000000000000000004.
/// @dev Interface mirrors circlefin/arc-node contracts/src/pq/IPQ.sol.
///      Gas: 230,000 base + 6 per 32-byte word of message.
interface IPQ {
    /// @param vk      SLH-DSA-SHA2-128s verifying key (32 bytes)
    /// @param message Message that was signed (FIPS 205 pure mode, empty context)
    /// @param sig     Signature (7856 bytes)
    function verifySlhDsaSha2128s(bytes calldata vk, bytes calldata message, bytes calldata sig)
        external
        view
        returns (bool);
}
