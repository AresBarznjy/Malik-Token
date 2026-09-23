// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMalikSaleToken {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IBNBUSDFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice A new, separately deployed sale contract. The old MalikPreSale cannot change its rate.
/// @dev The feed must be the BNB/USD feed on the same chain, not a token/USD or testnet feed.
contract MalikPreSaleUSD {
    uint256 public constant TOKENS_PER_USD = 1250;
    uint256 public constant MAX_TOKENS = 200_000_000;

    IMalikSaleToken public immutable token;
    IBNBUSDFeed public immutable bnbUsdFeed;
    address payable public immutable owner;
    uint256 public immutable tokenUnit;
    uint256 public immutable feedUnit;
    uint256 public immutable maxPriceAge;
    uint256 public immutable maxTokensForSale;
    uint256 public tokensSold;
    uint256 private locked;

    event Bought(address indexed buyer, uint256 bnbPaid, uint256 tokensReceived);

    constructor(address tokenAddress, address feedAddress, uint256 maxPriceAgeSeconds) {
        require(tokenAddress != address(0) && feedAddress != address(0), "Zero address");
        require(tokenAddress.code.length > 0 && feedAddress.code.length > 0, "Contract required");
        require(maxPriceAgeSeconds > 0 && maxPriceAgeSeconds <= 1 days, "Invalid max age");

        token = IMalikSaleToken(tokenAddress);
        bnbUsdFeed = IBNBUSDFeed(feedAddress);
        owner = payable(msg.sender);
        maxPriceAge = maxPriceAgeSeconds;

        uint8 tokenDecimals = token.decimals();
        uint8 oracleDecimals = bnbUsdFeed.decimals();
        require(tokenDecimals <= 18 && oracleDecimals <= 18, "Unsupported decimals");
        tokenUnit = 10 ** tokenDecimals;
        feedUnit = 10 ** oracleDecimals;
        maxTokensForSale = MAX_TOKENS * tokenUnit;
    }

    function bnbUsdPrice() public view returns (uint256) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            bnbUsdFeed.latestRoundData();
        require(roundId != 0 && answeredInRound >= roundId && answer > 0, "Invalid feed answer");
        require(updatedAt != 0 && updatedAt <= block.timestamp, "Invalid feed time");
        require(block.timestamp - updatedAt <= maxPriceAge, "Stale BNB/USD feed");
        return uint256(answer);
    }

    /// @param usdWad USD amount with 18 decimal places (1 USD = 1e18).
    /// @return weiAmount BNB wei required; rounded up so underpayment cannot occur.
    function bnbForUsd(uint256 usdWad) external view returns (uint256 weiAmount) {
        require(usdWad > 0, "Zero USD");
        uint256 price = bnbUsdPrice();
        uint256 numerator = usdWad * feedUnit;
        weiAmount = numerator / price;
        if (numerator % price != 0) weiAmount += 1;
    }

    function quote(uint256 bnbWei) public view returns (uint256 tokensOut) {
        tokensOut = bnbWei * bnbUsdPrice() * TOKENS_PER_USD * tokenUnit / (1 ether * feedUnit);
    }

    /// @notice Buyer sets a minimum; an oracle change between quote and inclusion reverts the payment.
    function buyTokens(uint256 minTokensOut) external payable {
        require(locked == 0, "Reentrant call");
        locked = 1;
        require(msg.value > 0 && minTokensOut > 0, "Invalid purchase");
        uint256 amount = quote(msg.value);
        require(amount >= minTokensOut, "Price changed");
        require(tokensSold + amount <= maxTokensForSale, "Sale cap reached");
        require(token.balanceOf(address(this)) >= amount, "Insufficient MLK inventory");

        tokensSold += amount;
        uint256 beforeBalance = token.balanceOf(msg.sender);
        _safeTransfer(msg.sender, amount);
        require(token.balanceOf(msg.sender) >= beforeBalance + amount, "Short token delivery");

        (bool paid,) = owner.call{value: msg.value}("");
        require(paid, "BNB payout failed");
        emit Bought(msg.sender, msg.value, amount);
        locked = 0;
    }

    function withdrawUnsoldTokens() external {
        require(msg.sender == owner, "Only owner");
        require(locked == 0, "Reentrant call");
        locked = 1;
        _safeTransfer(owner, token.balanceOf(address(this)));
        locked = 0;
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory result) = address(token).call(
            abi.encodeWithSelector(IMalikSaleToken.transfer.selector, to, amount)
        );
        require(ok && (result.length == 0 || (result.length == 32 && abi.decode(result, (bool)))), "MLK transfer failed");
    }
}
