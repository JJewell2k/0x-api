/**
 * This module can be used to run the Swap HTTP service standalone
 */
import { cacheControl, createDefaultServer } from '@0x/api-utils';
import * as express from 'express';
import * as core from 'express-serve-static-core';
import { Server } from 'http';

import { getDefaultAppDependenciesAsync } from '../app';
import {
    defaultHttpServiceConfig,
    SENTRY_DSN,
    SENTRY_ENVIRONMENT,
    SENTRY_SAMPLE_RATE,
    SENTRY_TRACES_SAMPLE_RATE,
} from '../config';
import { DEFAULT_CACHE_AGE_SECONDS, SWAP_PATH } from '../constants';
import { rootHandler } from '../handlers/root_handler';
import { logger } from '../logger';
import { addressNormalizer } from '../middleware/address_normalizer';
import { errorHandler } from '../middleware/error_handling';
import { createSwapRouter } from '../routers/swap_router';
import { SentryInit, SentryOptions } from '../sentry';
import { HttpServiceConfig, AppDependencies } from '../types';
import { providerUtils } from '../utils/provider_utils';

import { destroyCallback } from './utils';

process.on('uncaughtException', (err) => {
    logger.error(err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    if (err) {
        logger.error(err);
    }
});

if (require.main === module) {
    (async () => {
        const provider = providerUtils.createWeb3Provider(
            defaultHttpServiceConfig.ethereumRpcUrl,
            defaultHttpServiceConfig.rpcRequestTimeout,
            defaultHttpServiceConfig.shouldCompressRequest,
        );
        const config: HttpServiceConfig = {
            ...defaultHttpServiceConfig,
        };
        const dependencies = await getDefaultAppDependenciesAsync(provider, config);
        await runHttpServiceAsync(dependencies, config);
    })().catch((error) => logger.error(error.stack));
}

async function runHttpServiceAsync(
    dependencies: AppDependencies,
    config: HttpServiceConfig,
    _app?: core.Express,
): Promise<Server> {
    const app = _app || express();

    if (dependencies.hasSentry) {
        const options: SentryOptions = {
            app: app,
            dsn: SENTRY_DSN,
            environment: SENTRY_ENVIRONMENT,
            paths: [SWAP_PATH],
            sampleRate: SENTRY_SAMPLE_RATE,
            tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
        };

        SentryInit(options);
    }

    app.use(addressNormalizer);
    app.use(cacheControl(DEFAULT_CACHE_AGE_SECONDS));
    const server = createDefaultServer(config, app, logger, destroyCallback(dependencies));

    app.get('/', rootHandler);

    if (dependencies.swapService) {
        app.use(SWAP_PATH, createSwapRouter(dependencies.swapService));
    } else {
        logger.error(`Could not run swap service, exiting`);
        process.exit(1);
    }
    app.use(errorHandler);
    server.listen(config.httpPort);

    return server;
}
