// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title TestStockMarket
 * @notice Testnet simulation: buy and sell test shares of real stocks with USDC or EURC at the
 * live market price. Prices come as short-lived quotes signed by Strike's quote signer, so no
 * price is ever posted onchain and each trade is one transaction. Each quote names the token it
 * is priced in, so a USDC price can't be paid in EURC. Shares are 6 decimals; prices are token
 * units per share (both tokens have 6 decimals). On mainnet the same flow routes to a real
 * tokenized-stock venue instead of this contract.
 */
contract TestStockMarket {
    address public immutable quoteSigner;

    /// keccak256(symbol) => holder => shares (6 decimals)
    mapping(bytes32 => mapping(address => uint256)) public shares;

    event Bought(
        address indexed holder, address indexed token, string symbol, uint256 amountIn, uint256 sharesOut, uint256 price
    );
    event Sold(
        address indexed holder, address indexed token, string symbol, uint256 sharesIn, uint256 amountOut, uint256 price
    );

    error QuoteExpired();
    error BadQuote();
    error NotEnoughShares();
    error ZeroAmount();
    error TransferFailed();

    constructor(address quoteSigner_) {
        quoteSigner = quoteSigner_;
    }

    function buy(
        address token,
        string calldata symbol,
        uint256 amountIn,
        uint256 price,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 sharesOut) {
        _checkQuote(token, symbol, price, deadline, signature);
        sharesOut = (amountIn * 1e6) / price;
        if (sharesOut == 0) revert ZeroAmount();
        if (!IERC20Min(token).transferFrom(msg.sender, address(this), amountIn)) revert TransferFailed();
        shares[keccak256(bytes(symbol))][msg.sender] += sharesOut;
        emit Bought(msg.sender, token, symbol, amountIn, sharesOut, price);
    }

    function sell(
        address token,
        string calldata symbol,
        uint256 sharesIn,
        uint256 price,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 amountOut) {
        _checkQuote(token, symbol, price, deadline, signature);
        bytes32 key = keccak256(bytes(symbol));
        if (sharesIn == 0) revert ZeroAmount();
        if (shares[key][msg.sender] < sharesIn) revert NotEnoughShares();
        shares[key][msg.sender] -= sharesIn;
        amountOut = (sharesIn * price) / 1e6;
        if (!IERC20Min(token).transfer(msg.sender, amountOut)) revert TransferFailed();
        emit Sold(msg.sender, token, symbol, sharesIn, amountOut, price);
    }

    /// The digest Strike's quote signer signs (EIP-191) for one symbol's price in one token.
    function quoteDigest(address token, string calldata symbol, uint256 price, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), token, keccak256(bytes(symbol)), price, deadline));
    }

    function _checkQuote(address token, string calldata symbol, uint256 price, uint256 deadline, bytes calldata signature)
        private
        view
    {
        if (block.timestamp > deadline) revert QuoteExpired();
        if (price == 0 || signature.length != 65) revert BadQuote();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", quoteDigest(token, symbol, price, deadline))
        );
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        if (ecrecover(digest, v, r, s) != quoteSigner) revert BadQuote();
    }
}
