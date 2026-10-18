import * as store from './store.js';
import { assertDataEpoch, dataEpoch, serializeDataWrite } from './data-lifecycle.js';
import { DEFAULT_MODEL } from './genai.js';

const ATTEMPT_KEY = 'genaiLinkAttempt';
const identity = connection => connection ? connection.generation ?? JSON.stringify([connection.key, connection.linkedAt ?? null]) : null;
const cancelled = () => Object.assign(new Error('GenAI Studio connection was cancelled. Connect again when you are ready.'), { code: 'link-cancelled' });

async function readConnection() {
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
      case 'genai-read':
        return readConnection();
      case 'genai-refresh-begin': {
        const epoch = await dataEpoch();
        const connection = await readConnection();
        return { epoch, identity: identity(connection), connection };
      }
      case 'genai-refresh': {
        if (await dataEpoch() !== message.epoch) return [];
        const connection = await store.get(store.KEYS.genai);
        if (!connection || identity(connection) !== message.identity) return connection?.models ?? [];
        await store.set(store.KEYS.genai, { ...connection, models: message.models });
        return message.models;
      }
      case 'genai-set-model': {
        const connection = await readConnection();
        if (!connection) return;
        await store.set(store.KEYS.genai, { ...connection, model: message.model, modelChosen: message.model !== DEFAULT_MODEL });
        return;
      }
      case 'genai-unlink':
        await store.remove(ATTEMPT_KEY);
        await store.remove(store.KEYS.genai);
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
      case 'genai-link-finish': {
        await checkAttempt(message);
        const connection = { ...message.connection, generation: crypto.randomUUID() };
        await store.set(store.KEYS.genai, connection);
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
