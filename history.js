import { config } from './config.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = join(__dirname, 'history.json');

/**
 * Historial de mensajes recientes del canal.
 * Estructura: array de objetos { author, type, content, timestamp, replyTo }.
 *  - type: 'character' si es un personaje del bot, 'user' si es un humano real.
 * Persistencia en history.json para mantener contexto entre reinicios.
 */
let history = [];

// Cache global de username -> discordUserId para poder emular menciones/replies pings reales
export const userCache = new Map();

/**
 * Carga el historial desde el archivo history.json al iniciar el bot.
 * Si el archivo no existe o está corrupto, empieza con un array vacío.
 */
export function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      const raw = readFileSync(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        history = parsed;
        console.log(`[history] Historial cargado desde archivo: ${history.length} mensajes.`);
        return;
      }
    }
  } catch (err) {
    console.warn(`[history] No se pudo cargar el historial: ${err.message}. Empezando vacío.`);
  }
  history = [];
}

/**
 * Guarda el historial actual en el archivo history.json.
 */
function saveHistory() {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error(`[history] Error al guardar el historial: ${err.message}`);
  }
}

/**
 * Agrega un mensaje al historial, descartando el más antiguo si se supera el límite,
 * y persiste los cambios en history.json.
 * @param {string} author - Nombre del autor (usuario o nombre del webhook/personaje)
 * @param {'user'|'character'} type - Tipo de autor
 * @param {string} content - Contenido del mensaje
 * @param {Date}   timestamp - Fecha del mensaje
 * @param {string|null} replyTo - Nombre de la persona a la que se está respondiendo
 */
export function addToHistory(author, type, content, timestamp = new Date(), replyTo = null) {
  history.push({
    author,
    type,
    content,
    timestamp: timestamp.toISOString(),
    replyTo,
  });

  // Mantener el historial dentro del límite configurado
  while (history.length > config.bot.historySize) {
    history.shift();
  }

  // Persistir cambios
  saveHistory();
}

/**
 * Devuelve una copia del historial actual.
 * @returns {Array<{author: string, type: string, content: string, timestamp: string, replyTo: string|null}>}
 */
export function getHistory() {
  return [...history];
}

/**
 * Formatea el historial como texto legible para incluirlo en el prompt del modelo.
 * Incluye fecha/hora local, tipo de autor (personaje o usuario) y contexto de reply.
 * @returns {string}
 */
export function formatHistoryForPrompt() {
  if (history.length === 0) return '(sin mensajes previos)';

  return history
    .map((msg) => {
      // Fecha y hora local legible
      const date = new Date(msg.timestamp);
      const dateStr = date.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

      // Etiqueta de tipo
      const typeLabel = msg.type === 'character' ? '[PERSONAJE]' : '[USUARIO]';

      // Contexto de reply
      const replyStr = msg.replyTo ? ` → respondiendo a ${msg.replyTo}` : '';

      return `[${dateStr} ${timeStr}] ${typeLabel} ${msg.author}${replyStr}: ${msg.content}`;
    })
    .join('\n');
}
