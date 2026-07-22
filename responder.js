import { WebhookClient } from 'discord.js';
import { config } from './config.js';
import { askNvidia } from './nvidia.js';
import { getCharacterByName } from './characters.js';
import { userCache, addToHistory } from './history.js';

// Un único webhook reutilizado para todos los personajes.
const webhook = new WebhookClient({ url: config.discord.webhookUrl });

// ─── Cola de respuestas ────────────────────────────────────────────────────────
// Garantiza que los personajes respondan de a uno por vez, evitando la avalancha
// de respuestas simultáneas cuando los mensajes se acumulan.
const responseQueue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || responseQueue.length === 0) return;
  isProcessing = true;
  try {
    const task = responseQueue.shift();
    await task();
  } finally {
    isProcessing = false;
    // Pequeña pausa entre respuestas consecutivas para que no aparezcan pegadas
    if (responseQueue.length > 0) {
      setTimeout(processQueue, 600);
    }
  }
}

// ─── Cálculo de delay de escritura ────────────────────────────────────────────
// Simula el tiempo que tardaría una persona real en Discord: base de pensamiento
// + ~20 chars/s de tipeo casual. Jitter ±500ms para que no suene robótico.
// Min: 2500ms — Max: 8000ms
function calcTypingDelay(text) {
  const base = 2000;          // tiempo base de "pensar antes de escribir"
  const msPerChar = 50;       // ~20 chars/s → 50ms por char (tipeo casual)
  const raw = base + text.length * msPerChar;
  const jitter = (Math.random() - 0.5) * 1000; // ±500ms
  return Math.max(2500, Math.min(raw + jitter, 8000));
}

// ─── Contador de respuestas automáticas ───────────────────────────────────────
let consecutiveAutoResponses = 0;

export function resetAutoResponseCounter() {
  if (consecutiveAutoResponses > 0) {
    console.log('[responder] Contador de respuestas automáticas reseteado por mensaje humano.');
  }
  consecutiveAutoResponses = 0;
}

// ─── Trabajo real: llama a la API, espera el delay calculado y envía ──────────
async function doRespond(forceCharacter, replyToAuthor, channel) {
  // Mantener el typing activo renovándolo cada 8s (Discord lo descarta a los ~10s)
  let typingInterval = null;
  if (channel) {
    const sendTypingSafe = async () => {
      try { await channel.sendTyping(); } catch { /* ignorar */ }
    };
    await sendTypingSafe();
    typingInterval = setInterval(sendTypingSafe, 8_000);
    console.log('[responder] Indicador de escritura activo.');
  }

  // Llamada a la API
  const response = await askNvidia(forceCharacter, replyToAuthor);
  if (!response) {
    clearInterval(typingInterval);
    console.error('[responder] No se obtuvo respuesta válida de NVIDIA.');
    return false;
  }

  const { character: characterName, message, replyTo } = response;
  console.log(`[responder] NVIDIA eligió a "${characterName}": ${message}${replyTo ? ` (respondiendo a ${replyTo})` : ''}`);

  // Buscar el personaje en el registro
  const character = getCharacterByName(characterName);
  if (!character) {
    clearInterval(typingInterval);
    console.error(`[responder] Personaje desconocido: "${characterName}". Revisa characters.js`);
    return false;
  }

  // Armar el mensaje final con ping si corresponde
  let finalMessage = message;
  if (replyTo) {
    const targetUserId = userCache.get(replyTo.toLowerCase());
    finalMessage = targetUserId ? `<@${targetUserId}> ${message}` : `@${replyTo} ${message}`;
  }

  // Delay proporcional a la longitud del mensaje (simula tiempo de escritura)
  const delay = calcTypingDelay(finalMessage);
  console.log(`[responder] Simulando escritura durante ${(delay / 1000).toFixed(1)}s (${finalMessage.length} chars)...`);
  await new Promise((resolve) => setTimeout(resolve, delay));

  // Enviar el mensaje
  try {
    await webhook.send({
      content: finalMessage,
      username: character.name,
      avatarURL: character.avatar,
    });

    clearInterval(typingInterval);

    addToHistory(character.name, 'character', finalMessage, new Date(), replyTo || null);

    consecutiveAutoResponses++;
    console.log(
      `[responder] Mensaje enviado como "${character.name}". ` +
      `Respuestas automáticas consecutivas: ${consecutiveAutoResponses}/${config.bot.maxAutoResponses}`
    );
    return true;
  } catch (err) {
    clearInterval(typingInterval);
    console.error('[responder] Error al enviar el mensaje por webhook:', err.message);
    return false;
  }
}

// ─── Punto de entrada público ──────────────────────────────────────────────────
/**
 * Decide si responder (inmediatamente) y, si procede, encola el trabajo real.
 * La decisión es síncrona; la ejecución es serializada para evitar avalanchas.
 *
 * @param {boolean} isHumanMessage
 * @param {string|null} forceCharacter
 * @param {string|null} replyToAuthor
 * @param {object|null} channel
 * @returns {boolean} true si se encoló una respuesta
 */
export async function maybeRespond(isHumanMessage, forceCharacter = null, replyToAuthor = null, channel = null) {
  // Verificar límite de respuestas automáticas consecutivas
  // Se aplica SIEMPRE que sea una respuesta automática, incluso si hay forceCharacter
  if (!isHumanMessage && consecutiveAutoResponses >= config.bot.maxAutoResponses) {
    console.log(
      `[responder] Límite de ${config.bot.maxAutoResponses} respuestas automáticas consecutivas alcanzado. ` +
      'Esperando mensaje humano.'
    );
    return false;
  }

  // Tirada de dados
  if (!forceCharacter) {
    const roll = Math.random();
    if (roll > config.bot.responseProbability) {
      console.log(`[responder] No responde esta vez (roll: ${roll.toFixed(2)})`);
      return false;
    }
    console.log(`[responder] Respondiendo (roll: ${roll.toFixed(2)}). Encolando...`);
  } else {
    console.log(`[responder] Respuesta prioritaria por mención/reply a "${forceCharacter}". Encolando...`);
  }

  // Encolar el trabajo real
  responseQueue.push(() => doRespond(forceCharacter, replyToAuthor, channel));
  processQueue();
  return true;
}

