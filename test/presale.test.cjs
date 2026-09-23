const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const ganache = require('ganache');
const { ethers } = require('ethers');

const mocks = `
pragma solidity ^0.8.20;
contract MockToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
contract MockFeed {
    uint8 public constant decimals = 8;
    int256 public answer;
    uint256 public updatedAt;
    constructor(int256 initialPrice) { answer = initialPrice; updatedAt = block.timestamp; }
    function set(int256 newPrice, uint256 timestamp) external { answer = newPrice; updatedAt = timestamp; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}`;

function compile() {
    const source = fs.readFileSync(path.join(__dirname, '../contracts/MalikPreSaleUSD.sol'), 'utf8');
    const result = JSON.parse(solc.compile(JSON.stringify({
        language: 'Solidity',
        sources: { 'MalikPreSaleUSD.sol': { content: source }, 'Mocks.sol': { content: mocks } },
        settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    })));
    const errors = result.errors?.filter(e => e.severity === 'error') || [];
    assert.deepEqual(errors, [], errors.map(e => e.formattedMessage).join('\n'));
    return {
        sale: result.contracts['MalikPreSaleUSD.sol'].MalikPreSaleUSD,
        token: result.contracts['Mocks.sol'].MockToken,
        feed: result.contracts['Mocks.sol'].MockFeed,
    };
}

test('USD rate, BNB price changes, slippage, feed freshness, inventory and payout', async () => {
    const artifacts = compile();
    const chain = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3 } });
    const provider = new ethers.BrowserProvider(chain);
    const owner = await provider.getSigner(0);
    const buyer = await provider.getSigner(1);
    const deploy = (artifact, signer, args = []) =>
        new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy(...args);

    const token = await deploy(artifacts.token, owner);
    const feed = await deploy(artifacts.feed, owner, [800n * 10n ** 8n]);
    const sale = await deploy(artifacts.sale, owner, [await token.getAddress(), await feed.getAddress(), 7200]);
    await Promise.all([token.waitForDeployment(), feed.waitForDeployment(), sale.waitForDeployment()]);
    await (await token.mint(await sale.getAddress(), ethers.parseUnits('100000', 18))).wait();

    const oneUsd = ethers.parseUnits('1', 18);
    const minimum = ethers.parseUnits('1250', 18);
    const weiAt800 = await sale.bnbForUsd(oneUsd);
    assert.equal(weiAt800, ethers.parseEther('0.00125'));
    assert.equal(await sale.quote(weiAt800), minimum);

    const ownerBefore = await provider.getBalance(await owner.getAddress());
    await (await sale.connect(buyer).buyTokens(minimum, { value: weiAt800 })).wait();
    assert.equal(await token.balanceOf(await buyer.getAddress()), minimum);
    assert.equal(await sale.tokensSold(), minimum);
    assert.equal(await provider.getBalance(await owner.getAddress()), ownerBefore + weiAt800);

    const now = (await provider.getBlock('latest')).timestamp;
    await (await feed.set(400n * 10n ** 8n, now)).wait();
    assert.equal(await sale.bnbForUsd(oneUsd), ethers.parseEther('0.0025'));
    assert.equal(await sale.quote(ethers.parseEther('0.0025')), minimum);
    await assert.rejects(sale.connect(buyer).buyTokens.staticCall(minimum, { value: weiAt800 }), /Price changed/);
    await (await sale.connect(buyer).buyTokens(minimum, { value: ethers.parseEther('0.0025') })).wait();
    assert.equal(await token.balanceOf(await buyer.getAddress()), minimum * 2n);

    await (await feed.set(0, now)).wait();
    await assert.rejects(sale.quote(weiAt800), /Invalid feed answer/);
    await (await feed.set(400n * 10n ** 8n, now - 7201)).wait();
    await assert.rejects(sale.quote(weiAt800), /Stale BNB\/USD feed/);
    const fresh = (await provider.getBlock('latest')).timestamp;
    await (await feed.set(400n * 10n ** 8n, fresh)).wait();
    await assert.rejects(sale.connect(buyer).buyTokens.staticCall(ethers.parseUnits('101000', 18), {
        value: ethers.parseEther('0.0025'),
    }), /Price changed/);
    await assert.rejects(sale.connect(buyer).buyTokens.staticCall(ethers.parseUnits('100000', 18), {
        value: ethers.parseEther('0.2'),
    }), /Insufficient MLK inventory/);
});
