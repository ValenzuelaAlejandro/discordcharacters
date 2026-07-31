/**
 * index.js — Entry point del bot de Discord con personajes ficticios.
 *
 * Flujo:
 *  1. Llega un mensaje al canal configurado
 *  2. Se guarda en el historial de forma inmediata
 *  3. Si vino de un humano, se resetea el contador de respuestas automáticas
 *  4. Se agenda una respuesta con debounce adaptativo (Opción B):
 *     - El timer se resetea con cada mensaje nuevo
 *     - El delay crece 500ms por cada mensaje acumulado (base 1500ms, tope 5000ms)
 *     - Cuando el timer dispara, se llama a maybeRespond UNA SOLA VEZ
 *       con el historial ya completo y los parámetros del último mensaje
 */

import './config.js'; // Validación de variables de entorno al arrancar
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { addToHistory, userCache, loadHistory } from './history.js';
import { characters } from './characters.js';
import { maybeRespond, resetAutoResponseCounter } from './responder.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Conjunto de nombres de personajes para detectar mensajes de webhooks propios
const characterNames = new Set(characters.map((c) => c.name.toLowerCase()));

// ─── Debounce adaptativo pre-generación ───────────────────────────────────────
// Acumula mensajes durante una ventana corta antes de disparar maybeRespond.
// Esto evita que el bot genere con contexto incompleto cuando llegan ráfagas.
const DEBOUNCE_BASE_MS  = 1500; // delay mínimo tras el último mensaje
const DEBOUNCE_STEP_MS  =  500; // ms extra por cada mensaje acumulado
const DEBOUNCE_MAX_MS   = 5000; // tope duro aunque sigan llegando mensajes

let debounceTimer   = null; // handle del setTimeout activo
let debounceCount   = 0;    // mensajes acumulados en la ventana actual
let debounceParams  = null; // parámetros del ÚLTIMO mensaje (siempre se sobreescribe)

/**
 * Agenda (o re-agenda) una llamada a maybeRespond con delay adaptativo.
 * Cada mensaje nuevo resetea el timer y suma 500ms al delay, hasta el tope.
 * Cuando el timer finalmente dispara, se usa el contexto del mensaje más reciente.
 *
 * @param {boolean}     isHumanMessage
 * @param {string|null} repliedToCharacter
 * @param {string}      authorName
 * @param {object}      channel
 */
function scheduleResponse(isHumanMessage, repliedToCharacter, authorName, channel) {
  // Siempre actualizar con los params del último mensaje recibido
  debounceParams = { isHumanMessage, repliedToCharacter, authorName, channel };
  debounceCount++;

  // Cancelar el timer previo
  if (debounceTimer) clearTimeout(debounceTimer);

  // Delay adaptativo: crece con la cantidad de mensajes acumulados, con tope
  const delay = Math.min(DEBOUNCE_BASE_MS + (debounceCount - 1) * DEBOUNCE_STEP_MS, DEBOUNCE_MAX_MS);

  console.log(`[bot] Debounce: ${debounceCount} msg(s) acumulado(s), esperando ${delay}ms antes de generar.`);

  debounceTimer = setTimeout(() => {
    debounceTimer  = null;
    const count    = debounceCount;
    debounceCount  = 0;
    const params   = debounceParams;
    debounceParams = null;

    console.log(`[bot] Ventana cerrada (${count} msg(s)). Generando respuesta con historial completo.`);
    maybeRespond(params.isHumanMessage, params.repliedToCharacter, params.authorName, params.channel);
  }, delay);
}

client.once('clientReady', () => {
  // Cargar historial persistido al conectar
  loadHistory();

  console.log(`[bot] Conectado como ${client.user.tag}`);
  console.log(`[bot] Escuchando el canal: ${config.discord.channelId}`);
  console.log(`[bot] Probabilidad de respuesta: ${config.bot.responseProbability * 100}%`);
  console.log(`[bot] Máx. respuestas automáticas consecutivas: ${config.bot.maxAutoResponses}`);
  console.log(`[bot] Tamaño del historial: ${config.bot.historySize} mensajes`);
});

client.on('messageCreate', async (message) => {
  // Ignorar mensajes fuera del canal configurado
  if (message.channelId !== config.discord.channelId) return;

  // Ignorar mensajes del propio cliente (no webhooks)
  if (message.author.id === client.user.id) return;

  // Ignorar mensajes vacíos o sin contenido de texto
  const content = message.content?.trim();
  if (!content) return;

  // Determinar el nombre del autor
  // Los webhooks de personajes tienen isWebhook = true y su nombre coincide con un personaje
  const authorName = message.author.username || message.author.globalName || 'Desconocido';
  const isCharacterWebhook =
    message.webhookId != null &&
    characterNames.has(authorName.toLowerCase());

  // Un mensaje "humano" es cualquiera que NO sea nuestro webhook de personaje
  const isHumanMessage = !isCharacterWebhook;

  // Detectar si el mensaje es una respuesta (Reply) a otro mensaje
  let replyTo = null;
  let replyToContent = null;
  let repliedToCharacter = null;

  if (message.reference && message.reference.messageId) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMessage) {
        const refAuthor = referencedMessage.author.username || referencedMessage.author.globalName || 'Desconocido';
        replyTo = refAuthor;
        replyToContent = referencedMessage.content?.trim() || null;

        // Si fue una respuesta a un personaje de nuestra lista, lo priorizamos
        if (characterNames.has(refAuthor.toLowerCase())) {
          const matchedChar = characters.find(c => c.name.toLowerCase() === refAuthor.toLowerCase());
          if (matchedChar) {
            repliedToCharacter = matchedChar.name;
          }
        }
      }
    } catch (err) {
      console.warn('[bot] No se pudo obtener el mensaje referenciado:', err.message);
    }
  }

  // Detectar menciones de nombres de personajes en el texto del mensaje (palabras clave).
  // Aplica si no hay un reply explícito ya detectado y el autor no se menciona a sí mismo.
  if (!repliedToCharacter) {
    const contentLower = content.toLowerCase();
    const mentionedChar = characters.find(
      (c) => contentLower.includes(c.name.toLowerCase()) && c.name.toLowerCase() !== authorName.toLowerCase()
    );
    if (mentionedChar) {
      repliedToCharacter = mentionedChar.name;
      console.log(`[bot] Palabra clave detectada: "${mentionedChar.name}" mencionado por ${authorName}.`);
    }
  }

  // Guardar ID en cache si es humano para poder mencionarlo/hacerle reply
  if (isHumanMessage) {
    userCache.set(authorName.toLowerCase(), message.author.id);
  }

  // Log del mensaje recibido
  const origin = isCharacterWebhook ? 'personaje' : 'usuario';
  const replyLog = replyTo ? ` (en respuesta a ${replyTo})` : '';
  console.log(`[bot] [${origin}] ${authorName}${replyLog}: ${content.substring(0, 80)}`);

  // Los mensajes de personajes (webhooks propios) ya se registran en responder.js
  // directamente tras enviarlos, así que solo saltamos el addToHistory para evitar
  // duplicados.
  if (!isCharacterWebhook) {
    addToHistory(authorName, 'user', content, message.createdAt, replyTo, replyToContent);
  }

  // 2. Si fue un humano, resetear el contador de respuestas automáticas
  if (isHumanMessage) {
    resetAutoResponseCounter();
  }

  // 3. Agendar respuesta con debounce adaptativo.
  //    - No se llama a maybeRespond directamente; se agenda para que espere
  //      a que el historial se estabilice en caso de ráfaga de mensajes.
  //    - Si llega otro mensaje antes de que dispare el timer, se resetea.
  //    - Los parámetros siempre corresponden al mensaje más reciente.
  scheduleResponse(isHumanMessage, repliedToCharacter, authorName, message.channel);
});

// Manejo de errores no capturados
client.on('error', (err) => {
  console.error('[bot] Error de cliente Discord:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('[bot] Unhandled rejection:', err);
});

// Conexión
client.login(config.discord.token);