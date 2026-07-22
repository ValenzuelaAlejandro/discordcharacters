/**
 * index.js — Entry point del bot de Discord con personajes ficticios.
 *
 * Flujo:
 *  1. Llega un mensaje al canal configurado
 *  2. Se guarda en el historial
 *  3. Si vino de un humano, se resetea el contador de respuestas automáticas
 *  4. Se delega a responder.maybeRespond() para decidir si y cómo responder
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
  let repliedToCharacter = null;

  if (message.reference && message.reference.messageId) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMessage) {
        const refAuthor = referencedMessage.author.username || referencedMessage.author.globalName || 'Desconocido';
        replyTo = refAuthor;

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
  // duplicados — pero SÍ dejamos que maybeRespond evalúe si otro personaje reacciona.
  if (!isCharacterWebhook) {
    addToHistory(authorName, 'user', content, message.createdAt, replyTo);
  }

  // 2. Si fue un humano, resetear el contador de respuestas automáticas
  if (isHumanMessage) {
    resetAutoResponseCounter();
  }

  // 3. Intentar responder (pasando el personaje al que le respondió directamente, el autor del último mensaje y el canal)
  await maybeRespond(isHumanMessage, repliedToCharacter, authorName, message.channel);
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
