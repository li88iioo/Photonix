const HEALTH_CACHE_TTL_MS = Number(process.env.HEALTH_CACHE_TTL_MS || 30000);
let healthCache = { snapshot: null, expiresAt: 0 };
let pendingHealthCheckPromise = null;

function parseWorkerList(value, fallback = []) {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.split(',').map((name) => name.trim()).filter(Boolean);
    }
    return fallback;
}

const REQUIRED_WORKERS = new Set(parseWorkerList(process.env.HEALTH_REQUIRED_WORKERS, ['indexing']));
const OPTIONAL_WORKERS = new Set(
    parseWorkerList(process.env.HEALTH_OPTIONAL_WORKERS, ['settings', 'video'])
        .filter((name) => !REQUIRED_WORKERS.has(name))
);

function buildHealthProviders(overrides = {}) {
    const defaultDb = () => {
        const multiDb = require('../db/multi-db');
        return {
            dbAll: multiDb.dbAll,
            checkDatabaseHealth: multiDb.checkDatabaseHealth,
            dbHealthStatus: multiDb.dbHealthStatus,
        };
    };
    const defaultRedis = () => {
        const redisConfig = require('../config/redis');
        return {
            getAvailability: redisConfig.getAvailability,
            redis: redisConfig.redis,
            redisRequired: (process.env.ENABLE_REDIS || 'false').toLowerCase() === 'true',
        };
    };
    const defaultWorkers = () => {
        const workerManager = require('./worker.manager');
        return { performWorkerHealthCheck: workerManager.performWorkerHealthCheck };
    };

    return {
        db: (overrides.db && overrides.db()) || defaultDb(),
        redis: (overrides.redis && overrides.redis()) || defaultRedis(),
        workers: (overrides.workers && overrides.workers()) || defaultWorkers(),
    };
}

function decorateWorkers(rawStatus) {
    const requiredWorkers = REQUIRED_WORKERS.size > 0 ? REQUIRED_WORKERS : new Set(['indexing']);
    const optionalWorkers = OPTIONAL_WORKERS;
    const decoratedWorkers = {};
    let healthy = true;
    const issues = [];

    Object.entries(rawStatus || {}).forEach(([key, stateInfo]) => {
        const normalizedInfo = typeof stateInfo === 'object' && stateInfo !== null
            ? stateInfo
            : { state: stateInfo };
        const baseActive = typeof normalizedInfo.state === 'string'
            ? normalizedInfo.state === 'active'
            : Boolean(normalizedInfo.active);
        const workerActive = Boolean(baseActive);
        const isRequired = requiredWorkers.has(key);
        const status = workerActive
            ? 'active'
            : (isRequired ? 'unavailable' : (optionalWorkers.has(key) ? 'inactive_optional' : 'inactive'));

        decoratedWorkers[key] = {
            ...normalizedInfo,
            active: workerActive,
            status
        };

        if (isRequired && !workerActive) {
            healthy = false;
            issues.push(`worker_${key}`);
        }
    });

    requiredWorkers.forEach((key) => {
        if (!decoratedWorkers[key]) {
            decoratedWorkers[key] = { active: false, status: 'missing' };
            healthy = false;
            issues.push(`worker_${key}`);
        }
    });

    return { decoratedWorkers, healthy, issues };
}

async function computeHealthSummary(providerOverrides = {}) {
    const providers = buildHealthProviders(providerOverrides);
    const timestamp = new Date().toISOString();
    const summary = {
        status: 'ok',
        timestamp,
        issues: [],
        dependencies: {
            database: {},
            redis: {},
            workers: {},
        },
    };

    let healthy = true;

    try {
        const { dbAll, checkDatabaseHealth, dbHealthStatus } = providers.db;
        await checkDatabaseHealth();
        const connections = {};
        for (const [name, state] of dbHealthStatus.entries()) {
            connections[name] = state;
        }
        summary.dependencies.database.connections = connections;
        const connectionStates = Object.values(connections);
        const connectionsHealthy =
            connectionStates.length === 0 ||
            connectionStates.every((state) => state === 'connected');
        if (!connectionsHealthy) {
            healthy = false;
            summary.issues.push('database_connections');
        }

        const schema = {};
        try {
            await dbAll('main', 'SELECT 1 FROM items LIMIT 1');
            schema.items = { status: 'ok' };
        } catch (error) {
            schema.items = { status: 'missing', error: error.message };
            healthy = false;
            summary.issues.push('items_table');
        }

        try {
            await dbAll('main', 'SELECT 1 FROM items_fts LIMIT 1');
            schema.itemsFts = { status: 'ok' };
        } catch (error) {
            schema.itemsFts = { status: 'missing', error: error.message };
            healthy = false;
            summary.issues.push('items_fts_table');
        }

        summary.dependencies.database.schema = schema;
    } catch (error) {
        healthy = false;
        summary.issues.push('database_error');
        summary.dependencies.database.error = error.message;
    }

    try {
        const { getAvailability, redis, redisRequired } = providers.redis;
        const availability = getAvailability();
        summary.dependencies.redis.availability = availability;

        if (availability === 'ready') {
            try {
                summary.dependencies.redis.ping = await redis.ping();
            } catch (error) {
                healthy = false;
                summary.issues.push('redis_ping');
                summary.dependencies.redis.error = error.message;
            }
        } else if (redisRequired) {
            healthy = false;
            summary.issues.push('redis_unavailable');
        }
    } catch (error) {
        healthy = false;
        summary.issues.push('redis_error');
        summary.dependencies.redis.error = error.message;
    }

    try {
        const { performWorkerHealthCheck } = providers.workers;
        const workerStatus = performWorkerHealthCheck() || {};
        const { decoratedWorkers, healthy: workerHealthy, issues } = decorateWorkers(workerStatus);
        summary.dependencies.workers = decoratedWorkers;
        if (!workerHealthy) {
            healthy = false;
            summary.issues.push(...issues);
        }
    } catch (error) {
        healthy = false;
        summary.issues.push('worker_error');
        summary.dependencies.workers = { error: error.message };
    }

    if (!healthy) {
        summary.status = 'error';
    }

    return summary;
}

function getCachedHealthSummary(now = Date.now()) {
    if (healthCache.snapshot && now < healthCache.expiresAt) {
        return healthCache.snapshot;
    }
    return null;
}

function cacheHealthSummary(summary, now = Date.now()) {
    const ttl =
        summary.status === 'ok'
            ? HEALTH_CACHE_TTL_MS
            : Math.min(HEALTH_CACHE_TTL_MS, 5000);
    healthCache = {
        snapshot: summary,
        expiresAt: now + ttl,
    };
}

function resetHealthCache() {
    healthCache = { snapshot: null, expiresAt: 0 };
    pendingHealthCheckPromise = null;
}

async function getHealthSummary() {
    const now = Date.now();
    const cached = getCachedHealthSummary(now);
    if (cached) {
        return cached;
    }

    if (!pendingHealthCheckPromise) {
        pendingHealthCheckPromise = computeHealthSummary()
            .then((summary) => {
                cacheHealthSummary(summary, Date.now());
                return summary;
            })
            .finally(() => {
                pendingHealthCheckPromise = null;
            });
    }
    return pendingHealthCheckPromise;
}

module.exports = {
    getHealthSummary,
    computeHealthSummary,
    resetHealthCache,
};
