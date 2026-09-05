import { AsyncLocalStorage } from 'async_hooks';
import { EntityManager } from 'typeorm';

export const tenantContextStorage = new AsyncLocalStorage<EntityManager>();
