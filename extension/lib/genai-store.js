import * as store from './store.js';
import { assertDataEpoch, dataEpoch, serializeDataWrite } from './data-lifecycle.js';
import { DEFAULT_MODEL } from './genai.js';
import { apiPermission, customConnection } from './llm-config.js';

const ATTEMPT_KEY = 'genaiLinkAttempt';
const identity = connection => connection ? connection.generation ?? JSON.stringify([connection.key, connection.linkedAt ?? null]) : null;
const cancelled = () => Object.assign(new Error('GenAI Studio connection was cancelled. Connect again when you are ready.'), { code: 'link-cancelled' });

async function activeKey() {
  return await store.get(store.KEYS.llmProvider) === 'custom' ? store.KEYS.customLlm : store.KEYS.genai;
}

async function readConnection() {
  if (await activeKey() === store.KEYS.customLlm) return store.get(store.KEYS.customLlm);
  const connection = await store.get(store.KEYS.genai);
  if (!connection || connection.modelChosen || connection.model === DEFAULT_MODEL) return connection;
  if (connection.models && !connection.models.includes(DEFAULT_MODEL)) return connection;
  const next = { ...connection, model: DEFAULT_MODEL };
  await store.set(store.KEYS.genai, next);
  return next;
}

async function checkAttempt(message) {
  await assertDataEpoch(message.epoch);
  const attempt = await store.get(ATTEMPT_KEY);
  if (!attempt || attempt.id !== message.attemptId || attempt.epoch !== message.epoch) throw cancelled();
}

// All connection mutations share the background queue with Clear local data.
export function handleGenaiDataRequest(message) {
  return serializeDataWrite(async () => {
    switch (message.action) {
      case 'genai-api-access':
        return chrome.permissions.contains({ origins: [apiPermission(message.baseUrl)] });
      case 'genai-read':
        return readConnection();
      case 'genai-refresh-begin': {
        const epoch = await dataEpoch();
        const connection = await readConnection();
        return { epoch, identity: identity(connection), connection };
      }
      case 'genai-refresh': {
        if (await dataEpoch() !== message.epoch) return [];
        const key = await activeKey();
        const connection = await store.get(key);
        if (!connection || identity(connection) !== message.identity) return connection?.models ?? [];
        await store.set(key, { ...connection, models: message.models });
        return message.models;
      }
      case 'genai-set-model': {
        if (message.provider && message.provider !== (await activeKey() === store.KEYS.customLlm ? 'custom' : 'purdue')) throw new Error('The model provider changed. Select the model again.');
        const connection = await readConnection();
        if (!connection) return;
        await store.set(await activeKey(), { ...connection, model: message.model, modelChosen: message.model !== DEFAULT_MODEL });
        return;
      }
      case 'genai-unlink': {
        if (message.provider && !['purdue', 'custom'].includes(message.provider)) throw new Error('Unknown model provider.');
        await store.remove(ATTEMPT_KEY);
        const key = message.provider ? (message.provider === 'custom' ? store.KEYS.customLlm : store.KEYS.genai) : await activeKey();
        await store.remove(key);
        return;
      }
      case 'genai-provider':
        if (!['purdue', 'custom'].includes(message.provider)) throw new Error('Unknown model provider.');
        await store.remove(ATTEMPT_KEY);
        await store.set(store.KEYS.llmProvider, message.provider);
        return;
      case 'genai-link-begin': {
        const epoch = await dataEpoch();
        const attemptId = crypto.randomUUID();
        await store.set(ATTEMPT_KEY, { epoch, id: attemptId });
        return { epoch, attemptId };
      }
      case 'genai-link-check':
        await checkAttempt(message);
        return;
      case 'genai-custom-finish':
      case 'genai-link-finish': {
        await checkAttempt(message);
        const custom = message.action === 'genai-custom-finish';
        const values = custom ? customConnection(message.connection) : message.connection;
        if (custom && !await chrome.permissions.contains({ origins: [apiPermission(values.baseUrl)] })) throw new Error('Allow access to the API site before saving.');
        const connection = { ...values, generation: crypto.randomUUID() };
        await chrome.storage.local.set({ [custom ? store.KEYS.customLlm : store.KEYS.genai]: connection, [store.KEYS.llmProvider]: custom ? 'custom' : 'purdue' });
        await store.remove(ATTEMPT_KEY);
        return connection;
      }
      case 'genai-link-cancel': {
        const attempt = await store.get(ATTEMPT_KEY);
        if (attempt?.id === message.attemptId && attempt.epoch === message.epoch) await store.remove(ATTEMPT_KEY);
        return;
      }
      default:
        throw new Error('Unknown GenAI Studio data action.');
    }
  });
}
