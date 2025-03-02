import { getTokenMetadataIfExists } from '@0x/token-metadata';
import { MarketOperation } from '@0x/types';
import { BigNumber } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import * as _ from 'lodash';

import {
    ChainId,
    DEFAULT_GAS_SCHEDULE,
    ERC20BridgeSource,
    GasSchedule,
    PriceComparisonsReport,
    SELL_SOURCE_FILTER_BY_CHAIN_ID,
    UniswapV2FillData,
} from '../asset-swapper';
import { CHAIN_ID } from '../config';
import { GAS_LIMIT_BUFFER_MULTIPLIER, TX_BASE_GAS, ZERO } from '../constants';
import { logger } from '../logger';
import { SourceComparison, ISlippageModelManager } from '../types';

// NOTE: Our internal Uniswap gas usage may be lower than the Uniswap UI usage
// Therefore we need to adjust the gas estimates to be representative of using the Uniswap UI.
const gasScheduleWithOverrides: GasSchedule = {
    ...DEFAULT_GAS_SCHEDULE,
    [ERC20BridgeSource.UniswapV2]: (fillData) => {
        let gas = 1.5e5;
        if ((fillData as UniswapV2FillData).tokenAddressPath.length > 2) {
            gas += 5e4;
        }
        return gas;
    },
    [ERC20BridgeSource.SushiSwap]: (fillData) => {
        let gas = 1.5e5;
        if ((fillData as UniswapV2FillData).tokenAddressPath.length > 2) {
            gas += 5e4;
        }
        return gas;
    },
};

const NULL_SOURCE_COMPARISONS = SELL_SOURCE_FILTER_BY_CHAIN_ID[CHAIN_ID].sources.reduce<SourceComparison[]>(
    (memo, liquiditySource) => {
        memo.push({
            name: liquiditySource,
            price: null,
            gas: null,
            savingsInEth: null,
            buyAmount: null,
            sellAmount: null,
            expectedSlippage: null,
        });
        return memo;
    },
    [],
);

export const priceComparisonUtils = {
    getPriceComparisonFromQuote(
        chainId: ChainId,
        side: MarketOperation,
        quote: PartialQuote,
        slippageModelManager: ISlippageModelManager | undefined,
        maxSlippageRate: number,
    ): SourceComparison[] | undefined {
        try {
            return getPriceComparisonFromQuoteOrThrow(chainId, side, quote, slippageModelManager, maxSlippageRate);
        } catch (e) {
            logger.error(`Error calculating price comparisons, skipping [${e}]`);
            return undefined;
        }
    },
    renameNative(sc: SourceComparison): SourceComparison {
        return {
            ...sc,
            name: sc.name === ERC20BridgeSource.Native ? '0x' : sc.name,
        };
    },
};

interface PartialQuote {
    buyTokenAddress: string;
    sellTokenAddress: string;
    buyAmount: BigNumber;
    sellAmount: BigNumber;
    sellTokenToEthRate: BigNumber;
    buyTokenToEthRate: BigNumber;
    gasPrice: BigNumber;
    estimatedGas: BigNumber;
    priceComparisonsReport?: PriceComparisonsReport;
}

function getPriceComparisonFromQuoteOrThrow(
    chainId: ChainId,
    side: MarketOperation,
    quote: PartialQuote,
    slippageModelManager: ISlippageModelManager | undefined,
    maxSlippageRate: number,
): SourceComparison[] | undefined {
    // Set up variables for calculation
    const buyToken = getTokenMetadataIfExists(quote.buyTokenAddress, chainId);
    const sellToken = getTokenMetadataIfExists(quote.sellTokenAddress, chainId);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- TODO: fix me!
    const ethToken = getTokenMetadataIfExists('WETH', chainId)!;
    const ethUnitAmount = new BigNumber(10).pow(ethToken.decimals);
    if (!buyToken || !sellToken || !quote.buyAmount || !quote.sellAmount || !quote.priceComparisonsReport) {
        logger.warn('Missing data to generate price comparisons');
        return undefined;
    }
    const isSelling = side === MarketOperation.Sell;
    const quoteTokenToEthRate = isSelling ? quote.buyTokenToEthRate : quote.sellTokenToEthRate;

    const { priceComparisonsReport } = quote;
    // Filter out samples with invalid amounts

    const allSources = [
        ...priceComparisonsReport.dexSources,
        ...priceComparisonsReport.multiHopSources,
        ...priceComparisonsReport.nativeSources,
    ];
    const fullTradeSources = allSources.filter((s) =>
        isSelling
            ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- TODO: fix me!
              s.takerAmount.isEqualTo(quote.sellAmount!) && s.makerAmount.isGreaterThan(ZERO)
            : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- TODO: fix me!
              s.makerAmount.isEqualTo(quote.buyAmount!) && s.takerAmount.isGreaterThan(ZERO),
    );

    // Calculate the maker/taker amounts after factoring in gas costs
    const tradeSourcesWithGas = fullTradeSources.map((source) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- TODO: fix me!
        const gas = TX_BASE_GAS.plus(new BigNumber(gasScheduleWithOverrides[source.liquiditySource]!(source.fillData)));

        const gasCost = gas.times(quote.gasPrice).dividedBy(ethUnitAmount).times(quoteTokenToEthRate);
        const unitMakerAmount = Web3Wrapper.toUnitAmount(source.makerAmount, buyToken.decimals);
        const unitMakerAmountAfterGasCosts = isSelling ? unitMakerAmount.minus(gasCost) : unitMakerAmount;
        const unitTakerAmount = Web3Wrapper.toUnitAmount(source.takerAmount, sellToken.decimals);
        const unitTakerAmountAfterGasCosts = isSelling ? unitTakerAmount : unitTakerAmount.plus(gasCost);
        let expectedSlippage = null;

        if (slippageModelManager) {
            expectedSlippage = slippageModelManager?.calculateExpectedSlippage(
                quote.buyTokenAddress,
                quote.sellTokenAddress,
                source.makerAmount,
                source.takerAmount,
                [{ name: source.liquiditySource, proportion: new BigNumber(1) }],
                maxSlippageRate,
            );
        }

        return {
            ...source,
            gas,
            unitTakerAmount,
            unitMakerAmount,
            unitTakerAmountAfterGasCosts,
            unitMakerAmountAfterGasCosts,
            expectedSlippage,
        };
    });

    // NOTE: Sort sources by the best outcome for the user
    // if the user is selling we want to maximize the maker amount they will receive
    // if the user is buying we want to minimize the taker amount they have to pay
    const sortedSources = isSelling
        ? tradeSourcesWithGas.slice().sort((a, b) => {
              return b.unitMakerAmountAfterGasCosts.comparedTo(a.unitMakerAmountAfterGasCosts);
          })
        : tradeSourcesWithGas.slice().sort((a, b) => {
              return a.unitTakerAmountAfterGasCosts.comparedTo(b.unitTakerAmountAfterGasCosts);
          });
    // Select the best (first in the sorted list) quote from each source
    const bestQuotesFromEverySource = _.uniqBy(sortedSources, 'liquiditySource');

    // *** Calculate additional fields that we want to return *** //

    // Calculate savings (Part 1): Cost of the quote including gas
    const quoteGasCostInTokens = quote.estimatedGas
        .dividedBy(GAS_LIMIT_BUFFER_MULTIPLIER) // Remove gas estimate safety buffer that we added to the quote
        .times(quote.gasPrice)
        .dividedBy(ethUnitAmount)
        .times(quoteTokenToEthRate);
    const unitAmount = isSelling
        ? Web3Wrapper.toUnitAmount(quote.buyAmount, buyToken.decimals)
        : Web3Wrapper.toUnitAmount(quote.sellAmount, sellToken.decimals);
    const unitAmountAfterGasCosts = isSelling
        ? unitAmount.minus(quoteGasCostInTokens)
        : unitAmount.plus(quoteGasCostInTokens);
    const roundingStrategy = isSelling ? BigNumber.ROUND_FLOOR : BigNumber.ROUND_CEIL;

    // Transform the fields
    const sourcePrices: SourceComparison[] = bestQuotesFromEverySource.map((source) => {
        const { liquiditySource, unitMakerAmount, unitTakerAmount, gas } = source;

        // calculate price
        const price = isSelling
            ? unitMakerAmount.dividedBy(unitTakerAmount).decimalPlaces(buyToken.decimals, roundingStrategy)
            : unitTakerAmount.dividedBy(unitMakerAmount).decimalPlaces(sellToken.decimals, roundingStrategy);

        // calculate savings (Part 2):
        const savingsInTokens = isSelling
            ? unitAmountAfterGasCosts.minus(source.unitMakerAmountAfterGasCosts)
            : source.unitTakerAmountAfterGasCosts.minus(unitAmountAfterGasCosts);
        const savingsInEth = quoteTokenToEthRate.gt(ZERO)
            ? savingsInTokens.dividedBy(quoteTokenToEthRate).decimalPlaces(ethToken.decimals)
            : ZERO;

        let expectedSlippage = null;

        if (slippageModelManager) {
            expectedSlippage = slippageModelManager?.calculateExpectedSlippage(
                quote.buyTokenAddress,
                quote.sellTokenAddress,
                source.makerAmount,
                source.takerAmount,
                [{ name: source.liquiditySource, proportion: new BigNumber(1) }],
                maxSlippageRate,
            );
        }

        return {
            name: liquiditySource,
            price,
            sellAmount: source.takerAmount,
            buyAmount: source.makerAmount,
            gas,
            savingsInEth,
            expectedSlippage,
        };
    });

    // Add null values for all sources we don't have a result for so that we always have a full result set in the response
    const allSourcePrices = _.uniqBy<SourceComparison>([...sourcePrices, ...NULL_SOURCE_COMPARISONS], 'name');
    return allSourcePrices;
}
